import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type GitCommit,
	type GitEvent,
	type GitSummary,
	type ShellRun,
	sanitize,
} from "@claude-lookout/protocol";
import * as git from "./git.ts";

/** A shell command in the foreground can't run longer than this; Claude Code stops it. */
const FOREGROUND_MAX_MS = 10 * 60_000;
const EVENTS_MAX = 30;
const COMMITS_MAX = 20;
const DROPPED_SHOWN = 5;
const SUBJECT_MAX = 200;
/** Past this many remembered results the cache starts over. */
const CACHE_MAX = 2000;

/** What the git reads need to know about a session. */
export interface SessionGit {
	id: string;
	/** When the session was first seen; git work from before it isn't the session's. */
	since: number;
	shell: ShellRun[];
	/** Closed sessions still get credit for what they did, but are shown nothing. */
	gone?: boolean;
}

/** What one session is shown about its repository. */
export interface GitView {
	git: GitSummary;
	gitCommits: GitCommit[];
	gitActivity: GitEvent[];
}

/** Something that happened in git, worked out from a reflog or from refs that changed. */
interface Happening {
	at: number;
	event: Omit<GitEvent, "at" | "by" | "earlier">;
	/** Commits it created or rewrote, by full hash. */
	made: string[];
	/** For a rewrite, when the oldest rewritten commit was first written. */
	rewroteFrom?: number;
	/** The session whose shell command did it, when one did. */
	owner?: string | undefined;
}

function short(ref: string): string {
	return /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 7) : sanitize(ref, SUBJECT_MAX);
}

function subject(text: string): string {
	return sanitize(text, SUBJECT_MAX);
}

function runEnd(run: ShellRun, now: number): number {
	return run.end ?? Math.min(now, run.start + FOREGROUND_MAX_MS);
}

/** The session whose shell command was running at some point in [from, to]. */
export function ownerOf(
	sessions: SessionGit[],
	from: number,
	to: number,
	now: number,
): string | undefined {
	let owner: string | undefined;
	let latest = -1;
	for (const session of sessions) {
		for (const run of session.shell) {
			if (run.start <= to && from <= runEnd(run, now) && run.start > latest) {
				owner = session.id;
				latest = run.start;
			}
		}
	}
	return owner;
}

/** Reflog times are whole seconds, so an entry may have been written any time in its second. */
const SECOND = 999;

/** Rebase steps as reflogs name them, for rebases and `pull --rebase`. */
const STEP =
	/^((?:rebase|pull)\b.*?) \((start|pick|fixup|squash|reword|edit|continue|skip|finish|abort)\)(?:: ?(.*))?$/;
const FOLD_MARK = /^(?:(?:fixup|squash|amend)! )+/;

/** Remembers what each reflog line amounts to; commits never change, so neither does the answer. */
type Cache = Map<string, Promise<Happening | undefined>>;

function cached(
	cache: Cache,
	key: string,
	read: () => Promise<Happening | undefined>,
): Promise<Happening | undefined> {
	let hit = cache.get(key);
	if (!hit) {
		if (cache.size >= CACHE_MAX) cache.clear();
		// A read that failed is left out this time and tried again next time, never remembered.
		hit = read().catch(() => {
			cache.delete(key);
			return undefined;
		});
		cache.set(key, hit);
	}
	return hit;
}

/** One HEAD reflog line outside a rebase. */
async function single(root: string, e: git.ReflogEntry): Promise<Happening | undefined> {
	const base = { at: e.at };
	const m = e.message;
	let r: RegExpMatchArray | null = m.match(/^commit(?: \((initial|amend|merge)\))?: (.*)$/);
	if (r) {
		const made = [e.new];
		if (r[1] === "amend") {
			const [commit] = await git.commitsBetween(root, "", e.new, 1);
			return {
				...base,
				event: { kind: "amend", subject: subject(r[2] ?? ""), sha: short(e.new) },
				made,
				...(commit ? { rewroteFrom: commit.authoredAt } : {}),
			};
		}
		if (r[1] === "merge") {
			const count = Math.max(0, (await git.countBetween(root, e.old, e.new)) - 1);
			return { ...base, event: { kind: "merge", subject: subject(r[2] ?? ""), count }, made };
		}
		return {
			...base,
			event: { kind: "commit", subject: subject(r[2] ?? ""), sha: short(e.new) },
			made,
		};
	}
	r = m.match(/^(merge (.+?)|pull\b[^:]*): (Fast-forward|.*)$/);
	if (r) {
		const fastForward = r[3] === "Fast-forward";
		const count = (await git.countBetween(root, e.old, e.new)) - (fastForward ? 0 : 1);
		const pull = r[1]?.startsWith("pull");
		return {
			...base,
			event: {
				kind: pull ? "pull" : "merge",
				...(pull ? {} : { ref: short(r[2] ?? "") }),
				count: Math.max(0, count),
				...(fastForward ? { fastForward: true as const } : {}),
			},
			made: fastForward ? [] : [e.new],
		};
	}
	r = m.match(/^(cherry-pick|revert): (.*)$/);
	if (r) {
		const kind = r[1] === "revert" ? "revert" : "cherry-pick";
		return {
			...base,
			event: { kind, subject: subject(r[2] ?? ""), sha: short(e.new) },
			made: [e.new],
		};
	}
	r = m.match(/^reset: moving to (.*)$/);
	if (r) {
		// Resetting to where HEAD already is, as `git stash` does, moves nothing.
		if (e.old === e.new) return undefined;
		const dropped = await git.commitsBetween(root, e.new, e.old, 100);
		return {
			...base,
			event: {
				kind: "reset",
				ref: short(r[1] ?? ""),
				count: dropped.length,
				...(dropped.length
					? { dropped: dropped.slice(0, DROPPED_SHOWN).map((c) => subject(c.subject)) }
					: {}),
			},
			made: [],
		};
	}
	r = m.match(/^checkout: moving from (.+) to (.+)$/);
	if (r) {
		if (r[1] === r[2]) return undefined;
		return {
			...base,
			event: { kind: "switch", from: short(r[1] ?? ""), ref: short(r[2] ?? "") },
			made: [],
		};
	}
	if (!m) return undefined;
	return { ...base, event: { kind: "other", subject: subject(m) }, made: [] };
}

/**
 * Pair the commits a rewrite started from with the ones it produced. Author name and time
 * survive a rewrite; commits written in the same second share them, so the subject decides.
 */
function match(
	before: git.CommitInfo[],
	after: git.CommitInfo[],
): { reworded: number; gone: git.CommitInfo[] } {
	const key = (c: git.CommitInfo) => `${c.authoredAt} ${c.authorEmail}`;
	const pool = new Map<string, git.CommitInfo[]>();
	for (const c of before) pool.set(key(c), [...(pool.get(key(c)) ?? []), c]);
	const take = (c: git.CommitInfo, same: boolean) => {
		const candidates = pool.get(key(c)) ?? [];
		const i = candidates.findIndex((o) => !same || o.subject === c.subject);
		if (i < 0) return false;
		candidates.splice(i, 1);
		return true;
	};
	const unmatched = after.filter((c) => !take(c, true));
	const reworded = unmatched.filter((c) => take(c, false)).length;
	return { reworded, gone: [...pool.values()].flat() };
}

/** A whole rebase, from its start line to its finish or abort. */
async function rebase(
	root: string,
	entries: git.ReflogEntry[],
	pull: boolean,
	ended: "finish" | "abort" | undefined,
): Promise<Happening> {
	const start = entries[0] as git.ReflogEntry;
	const last = entries.at(-1) as git.ReflogEntry;
	const target = start.message.match(/\): checkout (.+)$/)?.[1];
	const ref = target && !/^HEAD\b|^@/.test(target) ? short(target) : undefined;
	const kind = pull ? "pull" : "rebase";
	if (ended !== "finish") {
		const state = ended === "abort" ? { aborted: true as const } : { running: true as const };
		return { at: start.at, event: { kind, ...(ref ? { ref } : {}), ...state }, made: [] };
	}

	const before = await git.commitsBetween(root, start.new, start.old);
	const after = await git.commitsBetween(root, start.new, last.new);
	const { reworded, gone } = match(before, after);
	const marked = gone.filter((c) => FOLD_MARK.test(c.subject));
	const steps = entries
		.map((e) => e.message.match(STEP))
		.filter((s) => s?.[2] === "fixup" || s?.[2] === "squash");
	const folded = [
		...new Set([
			...marked.map((c) => subject(c.subject.replace(FOLD_MARK, ""))),
			...steps.map((s) => subject(s?.[3] ?? "")).filter(Boolean),
		]),
	];
	const removed = Math.max(0, gone.length - Math.max(marked.length, steps.length));
	// Commits a rebase left exactly as they were weren't rewritten.
	const unchanged = new Set(before.map((c) => c.sha));
	const rewritten = after.filter((c) => !unchanged.has(c.sha));
	const event: Happening["event"] = pull
		? { kind, count: await git.countBetween(root, start.old, start.new), replayed: after.length }
		: {
				kind,
				...(ref ? { ref } : {}),
				count: after.length,
				...(folded.length ? { folded } : {}),
				...(reworded ? { reworded } : {}),
				...(removed ? { removed } : {}),
			};
	return {
		at: start.at,
		event,
		made: rewritten.map((c) => c.sha),
		...(rewritten.length ? { rewroteFrom: Math.min(...rewritten.map((c) => c.authoredAt)) } : {}),
	};
}

/** Everything HEAD's reflog says happened since `since`. */
async function headHappenings(
	root: string,
	gitDir: string,
	since: number,
	cache: Cache,
): Promise<Happening[]> {
	const entries = await git.readReflog(join(gitDir, "logs", "HEAD"), since);
	const reads: Promise<Happening | undefined>[] = [];
	const lone = (e: git.ReflogEntry) =>
		reads.push(cached(cache, `${e.at} ${e.old} ${e.new} ${e.message}`, () => single(root, e)));
	type Group = { entries: git.ReflogEntry[]; pull: boolean };
	/**
	 * A rebase that neither finished nor aborted, because it was quit (`git rebase --quit`) or left
	 * behind. It never rewrote the branch, so it shows as stopped; what came after stands alone.
	 */
	const quit = (g: Group) => {
		const own = g.entries.findLastIndex((e) => /^(?:rebase|pull)\b/.test(e.message)) + 1;
		const first = g.entries[0] as git.ReflogEntry;
		const id = `${first.at} ${first.new} quit`;
		reads.push(cached(cache, id, () => rebase(root, g.entries.slice(0, own), g.pull, "abort")));
		for (const e of g.entries.slice(own)) lone(e);
	};
	let group: Group | undefined;
	for (const e of entries) {
		const step = e.message.match(STEP);
		if (step?.[2] === "start") {
			if (group) quit(group);
			group = { entries: [e], pull: step[1]?.startsWith("pull") ?? false };
			continue;
		}
		if (group) {
			group.entries.push(e);
			const ended = step?.[2] === "finish" || step?.[2] === "abort" ? step[2] : undefined;
			if (ended) {
				const g = group;
				const first = g.entries[0] as git.ReflogEntry;
				const id = `${first.at} ${first.new} ${e.new} ${ended}`;
				reads.push(cached(cache, id, () => rebase(root, g.entries, g.pull, ended)));
				group = undefined;
			}
			continue;
		}
		// The rest of a rebase that started before the session.
		if (step) continue;
		lone(e);
	}
	if (group) {
		if (git.readBusy(gitDir)?.kind === "rebase") {
			reads.push(rebase(root, group.entries, group.pull, undefined));
		} else quit(group);
	}
	return (await Promise.all(reads)).filter((h): h is Happening => h !== undefined);
}

/** Pushes and fetches, from the reflogs of remote branches. */
async function remoteHappenings(
	root: string,
	commonDir: string,
	since: number,
	cache: Cache,
): Promise<Happening[]> {
	const reads: Promise<Happening | undefined>[] = [];
	for (const { ref, file } of await git.remoteReflogs(commonDir)) {
		for (const e of await git.readReflog(file, since)) {
			// A pull shows up in HEAD's reflog, which says more.
			if (e.message.startsWith("pull")) continue;
			const id = `${ref} ${e.at} ${e.old} ${e.new} ${e.message}`;
			reads.push(
				cached(cache, id, async () => {
					const at = e.at;
					if (e.message === "update by push") {
						if (git.isNull(e.old)) return { at, event: { kind: "push", ref }, made: [] };
						const count = await git.countBetween(root, e.old, e.new);
						const forced = (await git.countBetween(root, e.new, e.old)) > 0;
						return {
							at,
							event: { kind: "push", ref, count, ...(forced ? { forced: true as const } : {}) },
							made: [],
						};
					}
					if (git.isNull(e.old) || e.old === e.new) return undefined;
					const count = await git.countBetween(root, e.old, e.new);
					return count > 0 ? { at, event: { kind: "fetch", ref, count }, made: [] } : undefined;
				}),
			);
		}
	}
	return (await Promise.all(reads)).filter((h): h is Happening => h !== undefined);
}

/** Branches, tags and stashes that appeared or went between two looks at the refs. */
function refChanges(before: git.RefSnapshot, after: git.RefSnapshot, at: number): Happening[] {
	const out: Happening[] = [];
	const name = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, "");
	const kind = (ref: string, made: boolean): GitEvent["kind"] =>
		ref.startsWith("refs/tags/")
			? made
				? "tag-created"
				: "tag-deleted"
			: made
				? "branch-created"
				: "branch-deleted";
	for (const ref of after.refs.keys()) {
		if (!before.refs.has(ref))
			out.push({ at, event: { kind: kind(ref, true), ref: short(name(ref)) }, made: [] });
	}
	for (const ref of before.refs.keys()) {
		if (!after.refs.has(ref))
			out.push({ at, event: { kind: kind(ref, false), ref: short(name(ref)) }, made: [] });
	}
	const stashed = after.stashes - before.stashes;
	if (stashed !== 0) {
		out.push({
			at,
			event: { kind: stashed > 0 ? "stash" : "unstash", count: Math.abs(stashed) },
			made: [],
		});
	}
	return out;
}

/**
 * What git says about one repository, credited session by session. Kept per repository so it
 * can tell which branches, tags and stashes came and went between reads.
 */
export class RepoGit {
	readonly root: string;
	private dirs: Promise<git.GitDirs | undefined>;
	private refs: git.RefSnapshot | undefined;
	private refsReadAt = 0;
	/** Branches, tags and stashes that came and went, oldest first. */
	private refEvents: Happening[] = [];
	private readonly cache: Cache = new Map();

	constructor(root: string) {
		this.root = root;
		this.dirs = git.gitDirs(root);
	}

	/** Where to look for changes, once the repository's folders are known. */
	gitDirs(): Promise<git.GitDirs | undefined> {
		// Asked again while git can't tell, so one failed read doesn't stop tracking for good.
		this.dirs = this.dirs.then((dirs) => dirs ?? git.gitDirs(this.root));
		return this.dirs;
	}

	/** Read the repository and work out what each open session is shown. */
	async read(sessions: SessionGit[], now: number): Promise<Map<string, GitView>> {
		const views = new Map<string, GitView>();
		const dirs = await this.gitDirs();
		const open = sessions.filter((s) => !s.gone);
		if (!dirs || open.length === 0) return views;
		const since = Math.min(...sessions.map((s) => s.since));

		const refs = await git.readRefs(this.root, dirs.commonDir);
		if (refs) {
			if (this.refs) {
				for (const h of refChanges(this.refs, refs, now)) {
					h.owner = ownerOf(sessions, this.refsReadAt, now, now);
					this.refEvents.push(h);
				}
				this.refEvents = this.refEvents.filter((h) => h.at >= since).slice(-EVENTS_MAX);
			}
			this.refs = refs;
			this.refsReadAt = now;
		}

		const hasReflog = existsSync(join(dirs.gitDir, "logs", "HEAD"));
		const happenings: Happening[] = [
			...(await headHappenings(this.root, dirs.gitDir, since, this.cache)),
			...(await remoteHappenings(this.root, dirs.commonDir, since, this.cache)),
		].map((h) => ({ ...h, owner: ownerOf(sessions, h.at, h.at + SECOND, now) }));
		happenings.push(...this.refEvents);
		happenings.sort((a, b) => a.at - b.at);

		const recent = await git.recentCommits(this.root, since);
		const remote = await git.hasRemote(this.root);
		const notPushed = remote
			? await git.unpushed(
					this.root,
					recent.map((c) => c.sha),
					since,
				)
			: undefined;
		const upstream = await git.readUpstream(this.root);
		const busy = git.readBusy(dirs.gitDir);

		for (const session of open) {
			views.set(
				session.id,
				viewFor(session, happenings, recent, hasReflog, notPushed, { upstream, busy }),
			);
		}
		return views;
	}
}

function viewFor(
	session: SessionGit,
	happenings: Happening[],
	recent: git.CommitInfo[],
	hasReflog: boolean,
	notPushed: Set<string> | undefined,
	repo: { upstream: GitSummary["upstream"]; busy: GitSummary["busy"] },
): GitView {
	const from = Math.floor(session.since / 1000) * 1000;
	// For each commit the session made, whether it got there by rewriting an existing one.
	const rewrites = new Map<string, boolean>();
	for (const h of happenings) {
		if (h.owner !== session.id) continue;
		for (const sha of h.made) rewrites.set(sha, h.rewroteFrom !== undefined);
	}
	// Without a reflog nothing can be credited, so every commit written since the session began counts.
	const mine = hasReflog
		? recent.filter((c) => rewrites.has(c.sha))
		: recent.filter((c) => c.authoredAt >= from);
	const commits: GitCommit[] = mine.map((c) => ({
		sha: c.sha.slice(0, 7),
		subject: subject(c.subject),
		added: c.added,
		removed: c.removed,
		files: c.files,
		...(rewrites.get(c.sha) && c.authoredAt < from ? { earlier: true as const } : {}),
		...(notPushed?.has(c.sha) ? { unpushed: true as const } : {}),
	}));

	const activity: GitEvent[] = happenings
		.filter((h) => h.at >= from)
		.map((h) => {
			const by =
				h.owner === session.id ? {} : { by: h.owner ? ("other" as const) : ("you" as const) };
			const earlier =
				h.rewroteFrom !== undefined && h.rewroteFrom < from ? { earlier: true as const } : {};
			return { at: h.at, ...h.event, ...by, ...earlier };
		})
		.reverse()
		.slice(0, EVENTS_MAX);

	const earlier = commits.filter((c) => c.earlier).length;
	const summary: GitSummary = {
		commits: commits.length - earlier,
		earlier,
		...(notPushed ? { unpushed: commits.filter((c) => c.unpushed).length } : {}),
		...(repo.upstream ? { upstream: repo.upstream } : {}),
		...(repo.busy ? { busy: repo.busy } : {}),
	};
	return { git: summary, gitCommits: commits.slice(0, COMMITS_MAX), gitActivity: activity };
}
