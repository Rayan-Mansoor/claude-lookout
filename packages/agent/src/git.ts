import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	FILE_CHANGES_MAX,
	type FileChange,
	type GitSummary,
	type WorkingChanges,
} from "@claude-lookout/protocol";

/** The checked-out branch for a folder, read straight from .git without running git. */
export function gitBranch(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		const dotGit = join(dir, ".git");
		const head = readHead(dotGit);
		if (head !== undefined) return head;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function readHead(dotGit: string): string | undefined {
	try {
		let gitDir = dotGit;
		if (statSync(dotGit).isFile()) {
			// Worktrees and submodules point at their real git dir.
			const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1];
			if (!pointer) return undefined;
			gitDir = resolve(dirname(dotGit), pointer.trim());
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
		return ref ?? head.slice(0, 7);
	} catch {
		return undefined;
	}
}

/** New files larger than this are counted as changed without counting their lines. */
const COUNT_LINES_MAX_BYTES = 1024 * 1024;
/** Status codes of a file that still has merge conflicts. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Run git without touching the repository: `--no-optional-locks` keeps it from refreshing the
 * index, so it never competes with git commands Claude runs at the same time.
 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((done) => {
		execFile(
			"git",
			["--no-optional-locks", ...args],
			{ cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout) => done(err ? undefined : stdout),
		);
	});
}

/**
 * A git read that failed (timed out, too much output, repository busy). Callers keep what they
 * showed before and try again later, rather than taking "no commits" for an answer.
 */
export class GitFailed extends Error {}

function answered(out: string | undefined): string {
	if (out === undefined) throw new GitFailed("git did not answer");
	return out;
}

/** The top folder of the repository holding `cwd`, or undefined outside git. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
	return (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined;
}

async function countLines(file: string): Promise<number> {
	try {
		if ((await stat(file)).size > COUNT_LINES_MAX_BYTES) return 0;
		const content = await readFile(file);
		if (content.includes(0)) return 0;
		const text = content.toString("utf8");
		return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
	} catch {
		return 0;
	}
}

/** Everything changed and not committed: staged, unstaged and new files. */
export async function readChanges(root: string): Promise<WorkingChanges | undefined> {
	const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (status === undefined) return undefined;

	const files = new Map<string, FileChange>();
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as string;
		if (entry.length < 4) continue;
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		// A rename or copy is followed by its old path.
		if (code.includes("R") || code.includes("C")) i++;
		const status: FileChange["status"] = CONFLICT_CODES.has(code)
			? "conflict"
			: code === "??" || code[0] === "A"
				? "new"
				: code.includes("D")
					? "deleted"
					: "changed";
		files.set(path, { path, added: 0, removed: 0, status });
	}

	const numstat = await git(root, ["diff", "--numstat", "-z", "HEAD"]);
	if (numstat !== undefined) {
		const parts = numstat.split("\0");
		for (let i = 0; i < parts.length; i++) {
			const match = (parts[i] as string).match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
			if (!match) continue;
			// A rename leaves the path empty and gives the old and new paths next.
			let path = match[3] as string;
			if (!path) {
				path = parts[i + 2] ?? "";
				i += 2;
			}
			const file = files.get(path);
			if (!file) continue;
			file.added = Number(match[1]) || 0;
			file.removed = Number(match[2]) || 0;
		}
	}
	for (const file of files.values()) {
		if (file.status === "new" && file.added === 0)
			file.added = await countLines(join(root, file.path));
	}

	const all = [...files.values()].sort(
		(a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path),
	);
	return {
		files: all.slice(0, FILE_CHANGES_MAX),
		total: all.length,
		added: all.reduce((sum, f) => sum + f.added, 0),
		removed: all.reduce((sum, f) => sum + f.removed, 0),
	};
}

/** Where a working tree keeps its own git files, and where the ones it shares live. */
export interface GitDirs {
	/** HEAD, its reflog, and any rebase or merge in progress. */
	gitDir: string;
	/** Branches, tags, remote branches and their reflogs. */
	commonDir: string;
}

export async function gitDirs(root: string): Promise<GitDirs | undefined> {
	const out = await git(root, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
	const [gitDir, commonDir] = out?.trim().split("\n") ?? [];
	if (!gitDir || !commonDir) return undefined;
	return { gitDir, commonDir: resolve(root, commonDir) };
}

/** One line of a reflog: a ref moved from `old` to `new`. */
export interface ReflogEntry {
	old: string;
	new: string;
	/** When, to the second. */
	at: number;
	message: string;
}

const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*> (\d+) [+-]\d{4}(?:\t(.*))?$/;

/** Reflog lines written since `since`, oldest first; none when the reflog doesn't exist. */
export async function readReflog(file: string, since: number): Promise<ReflogEntry[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const entries: ReflogEntry[] = [];
	const from = Math.floor(since / 1000);
	for (const line of text.split("\n")) {
		const match = line.match(REFLOG_LINE);
		if (!match || Number(match[3]) < from) continue;
		entries.push({
			old: match[1] as string,
			new: match[2] as string,
			at: Number(match[3]) * 1000,
			message: match[4] ?? "",
		});
	}
	return entries;
}

/** Every remote branch that has a reflog, as "origin/main", with its file. */
export async function remoteReflogs(commonDir: string): Promise<{ ref: string; file: string }[]> {
	const base = join(commonDir, "logs", "refs", "remotes");
	try {
		const names = await readdir(base, { recursive: true, withFileTypes: true });
		return names
			.filter((d) => d.isFile() && d.name !== "HEAD")
			.map((d) => {
				const file = join(d.parentPath, d.name);
				return { ref: relative(base, file).split(sep).join("/"), file };
			});
	} catch {
		return [];
	}
}

/** Whether `sha` is all zeros, as a reflog writes for a ref that didn't exist yet. */
export function isNull(sha: string): boolean {
	return /^0+$/.test(sha);
}

/** A commit as git log describes it. */
export interface CommitInfo {
	sha: string;
	/** Author time in ms: kept when a commit is amended, rebased or cherry-picked. */
	authoredAt: number;
	authorEmail: string;
	subject: string;
	added: number;
	removed: number;
	files: number;
}

const RECORD = "\x1e";

function parseLog(out: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const record of out.split(RECORD)) {
		const [head, ...rest] = record.split("\n");
		const [sha, at, email, subject] = (head ?? "").split("\0");
		if (!sha || !at) continue;
		const stat = rest.join(" ");
		commits.push({
			sha,
			authoredAt: Number(at) * 1000,
			authorEmail: email ?? "",
			subject: subject ?? "",
			files: Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0),
			added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0),
			removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0),
		});
	}
	return commits;
}

const LOG_FORMAT = `--format=${RECORD}%H%x00%at%x00%ae%x00%s`;

/** Commits reachable from `to` and not from `from`, newest first; `from` may be "". */
export async function commitsBetween(
	root: string,
	from: string,
	to: string,
	max = 500,
): Promise<CommitInfo[]> {
	const range = from && !isNull(from) ? [to, `^${from}`] : [to];
	return parseLog(
		answered(await git(root, ["log", LOG_FORMAT, "--shortstat", `-n${max}`, ...range, "--"])),
	);
}

/** Commits on any branch, or HEAD, that were committed since `since`, newest first. */
export async function recentCommits(root: string, since: number, max = 500): Promise<CommitInfo[]> {
	const out = await git(root, [
		"log",
		LOG_FORMAT,
		"--shortstat",
		`-n${max}`,
		`--since=@${Math.floor(since / 1000) - 1}`,
		"HEAD",
		"--branches",
		"--",
	]);
	if (out !== undefined) return parseLog(out);
	// Before the first commit there is no HEAD to read from, and nothing to show.
	if ((await git(root, ["rev-parse", "-q", "--verify", "HEAD"])) === undefined) return [];
	throw new GitFailed("git did not answer");
}

/** How many commits `to` has that `from` hasn't. */
export async function countBetween(root: string, from: string, to: string): Promise<number> {
	if (isNull(to)) return 0;
	const args = isNull(from) ? [to] : [to, `^${from}`];
	return Number(answered(await git(root, ["rev-list", "--count", ...args, "--"])).trim()) || 0;
}

/** The ones among `shas`, committed since `since`, that no remote branch has. */
export async function unpushed(root: string, shas: string[], since: number): Promise<Set<string>> {
	if (shas.length === 0) return new Set();
	const out = await git(root, [
		"rev-list",
		`--since=@${Math.floor(since / 1000) - 1}`,
		...shas,
		"--not",
		"--remotes",
		"--",
	]);
	const all = new Set(shas);
	return new Set(
		answered(out)
			.split("\n")
			.filter((sha) => all.has(sha)),
	);
}

export async function hasRemote(root: string): Promise<boolean> {
	return !!(await git(root, ["remote"]))?.trim();
}

/** The branch the checked-out branch tracks, and how far apart they are. */
export async function readUpstream(root: string): Promise<GitSummary["upstream"]> {
	const ref = (await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))?.trim();
	if (!ref) return undefined;
	const counts = (await git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]))
		?.trim()
		.split(/\s+/);
	return { ref, behind: Number(counts?.[0]) || 0, ahead: Number(counts?.[1]) || 0 };
}

function readNumber(file: string): number | undefined {
	try {
		return Number(readFileSync(file, "utf8").trim()) || undefined;
	} catch {
		return undefined;
	}
}

function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}

/** A git operation stopped half-way in this working tree, if any. */
export function readBusy(gitDir: string): GitSummary["busy"] {
	for (const dir of ["rebase-merge", "rebase-apply"]) {
		if (!exists(join(gitDir, dir))) continue;
		const merge = dir === "rebase-merge";
		const step = readNumber(join(gitDir, dir, merge ? "msgnum" : "next"));
		const total = readNumber(join(gitDir, dir, merge ? "end" : "last"));
		return { kind: "rebase", ...(step ? { step } : {}), ...(total ? { total } : {}) };
	}
	if (exists(join(gitDir, "MERGE_HEAD"))) return { kind: "merge" };
	if (exists(join(gitDir, "CHERRY_PICK_HEAD"))) return { kind: "cherry-pick" };
	if (exists(join(gitDir, "REVERT_HEAD"))) return { kind: "revert" };
	if (exists(join(gitDir, "BISECT_LOG"))) return { kind: "bisect" };
	return undefined;
}

/** Every branch and tag with the commit it points at, plus how many stashes there are. */
export interface RefSnapshot {
	refs: Map<string, string>;
	stashes: number;
}

export async function readRefs(root: string, commonDir: string): Promise<RefSnapshot | undefined> {
	const out = await git(root, [
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		"refs/heads",
		"refs/tags",
	]);
	if (out === undefined) return undefined;
	const refs = new Map<string, string>();
	for (const line of out.split("\n")) {
		const space = line.indexOf(" ");
		if (space > 0) refs.set(line.slice(space + 1), line.slice(0, space));
	}
	let stashes = 0;
	try {
		stashes = readFileSync(join(commonDir, "logs", "refs", "stash"), "utf8")
			.split("\n")
			.filter(Boolean).length;
	} catch {}
	return { refs, stashes };
}
