import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type HookInput, type Session, str } from "@claude-lookout/protocol";
import { type GitView, RepoGit, type SessionGit } from "./activity.ts";
import type { Agent } from "./agent.ts";
import * as git from "./git.ts";

/** What one repository answers; the real one reads git, tests stand in. */
export interface RepoReader {
	read(sessions: SessionGit[], now: number): Promise<Map<string, GitView>>;
	/** Call `changed` whenever git's own files change, until the returned stop is called. */
	watch(changed: () => void): () => void;
}

export interface ProgressGit {
	repoRoot(cwd: string): Promise<string | undefined>;
	readChanges: typeof git.readChanges;
	openRepo(root: string): RepoReader;
}

/** How soon a folder outside git is looked at again. */
const RECHECK_MS = 10_000;

/** Hook events after which the working tree or the commits may have changed. */
const CHANGING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);

export function changesProgress(input: HookInput): boolean {
	const e = input.hook_event_name;
	if (e === "SessionStart" || e === "Stop") return true;
	return e === "PostToolUse" && CHANGING_TOOLS.has(str(input.tool_name) ?? "");
}

/** Files git rewrites all the time without anything happening to commits or branches. */
const QUIET_FILES = /(^|[/\\])(index|FETCH_HEAD|COMMIT_EDITMSG|AUTO_MERGE|[^/\\]*\.lock)$/;

/** How often folders that couldn't be watched yet are tried again. */
const WATCH_RETRY_MS = 30_000;

/** Watch the folders where git records commits, branches and operations in progress. */
function watchGit(repo: RepoGit, changed: () => void): () => void {
	const watchers = new Map<string, FSWatcher>();
	let stopped = false;
	let retry: ReturnType<typeof setInterval> | undefined;
	const add = (path: string, recursive: boolean): boolean => {
		if (watchers.has(path)) return true;
		try {
			const w = watch(path, { recursive, persistent: false }, (_type, name) => {
				// Folders git creates later (logs/ appears with the first commit) can be watched now.
				void ensure();
				if (!name || !QUIET_FILES.test(String(name))) changed();
			});
			w.on("error", () => {
				// The folder went away; watch it again once it is back.
				w.close();
				watchers.delete(path);
				keepTrying();
			});
			watchers.set(path, w);
			return true;
		} catch {
			return false;
		}
	};
	/** Watch every folder there is to watch; true once all of them are. */
	const ensure = async (): Promise<boolean> => {
		const dirs = await repo.gitDirs();
		if (!dirs || stopped) return stopped;
		const all = [
			add(dirs.gitDir, false),
			add(join(dirs.gitDir, "logs"), true),
			dirs.commonDir === dirs.gitDir || add(dirs.commonDir, false),
			add(join(dirs.commonDir, "refs"), true),
			add(join(dirs.commonDir, "logs"), true),
		];
		return all.every(Boolean);
	};
	const keepTrying = () => {
		if (retry || stopped) return;
		retry = setInterval(() => {
			void ensure().then((done) => {
				if (done) {
					clearInterval(retry);
					retry = undefined;
				}
			});
		}, WATCH_RETRY_MS);
		retry.unref?.();
	};
	void ensure().then((done) => {
		if (!done) keepTrying();
	});
	return () => {
		stopped = true;
		clearInterval(retry);
		for (const w of watchers.values()) w.close();
		watchers.clear();
	};
}

export const realGit: ProgressGit = {
	repoRoot: git.repoRoot,
	readChanges: git.readChanges,
	openRepo(root) {
		const repo = new RepoGit(root);
		return { read: (sessions, now) => repo.read(sessions, now), watch: (c) => watchGit(repo, c) };
	},
};

interface Repo {
	reader: RepoReader;
	stopWatching?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	running: boolean;
	again: boolean;
}

/**
 * Keeps each session's git activity and uncommitted changes up to date. Reads are grouped per
 * repository and wait for a quiet moment, so a burst of edits costs a single git run. While a
 * session is open its repository is watched too, so git work done outside Claude shows up.
 */
export class ProgressTracker {
	private readonly agent: Agent;
	private readonly git: ProgressGit;
	private readonly delayMs: number;
	private readonly now: () => number;
	private readonly roots = new Map<string, Promise<string | undefined>>();
	/** Folders found outside git, and when; looked at again a little later, after a `git init`. */
	private readonly notRepos = new Map<string, number>();
	private readonly repos = new Map<string, Repo>();

	constructor(agent: Agent, gitReads: ProgressGit = realGit, delayMs = 2000, now = Date.now) {
		this.agent = agent;
		this.git = gitReads;
		this.delayMs = delayMs;
		this.now = now;
	}

	/** Follow the agent's sessions from now on. */
	start(): void {
		this.agent.onEvent((session, input) => {
			if (changesProgress(input)) void this.refresh(session);
		});
		// A closed session may have been the last one keeping its repository watched.
		this.agent.onTransition((session) => {
			if (session.state === "gone") void this.refresh(session);
		});
		for (const session of this.agent.sessions.values()) {
			if (session.state !== "gone") void this.refresh(session);
		}
	}

	/** Read the session's repository again once things settle. */
	async refresh(session: Session): Promise<void> {
		const root = await this.root(session);
		if (root) this.schedule(root);
	}

	private schedule(root: string): void {
		let repo = this.repos.get(root);
		if (!repo) {
			repo = { reader: this.git.openRepo(root), running: false, again: false };
			this.repos.set(root, repo);
			repo.stopWatching = repo.reader.watch(() => this.schedule(root));
		}
		const r = repo;
		clearTimeout(r.timer);
		r.timer = setTimeout(() => void this.read(root, r), this.delayMs);
	}

	private root(session: Session): Promise<string | undefined> {
		const cwd = str(session.fields.cwd);
		if (!cwd) return Promise.resolve(undefined);
		let root = this.roots.get(cwd);
		if (!root) {
			const checked = this.notRepos.get(cwd);
			if (checked !== undefined && this.now() - checked < RECHECK_MS) {
				return Promise.resolve(undefined);
			}
			root = this.git.repoRoot(cwd).then((found) => {
				if (!found) {
					this.roots.delete(cwd);
					this.notRepos.set(cwd, this.now());
				} else this.notRepos.delete(cwd);
				return found;
			});
			this.roots.set(cwd, root);
		}
		return root;
	}

	private async read(root: string, repo: Repo): Promise<void> {
		if (repo.running) {
			repo.again = true;
			return;
		}
		repo.running = true;
		try {
			const sessions: SessionGit[] = [];
			for (const session of [...this.agent.sessions.values()]) {
				if ((await this.root(session)) !== root) continue;
				sessions.push({
					id: session.id,
					since: session.startedAt,
					shell: session.shell ?? [],
					...(session.state === "gone" ? { gone: true } : {}),
				});
			}
			if (!sessions.some((s) => !s.gone)) {
				this.close(root, repo);
				return;
			}
			const changes = await this.git.readChanges(root);
			const views = await repo.reader.read(sessions, this.now()).catch(() => undefined);
			for (const session of sessions) {
				if (session.gone) continue;
				// A read that failed keeps what is shown rather than clearing it.
				const values: Record<string, unknown> = {};
				if (changes) values.changes = changes.total > 0 ? changes : null;
				const view = views?.get(session.id);
				if (view) {
					const g = view.git;
					const shown = g.commits || g.earlier || g.upstream || g.busy;
					values.git = shown ? g : null;
					values.gitCommits = view.gitCommits.length ? view.gitCommits : null;
					values.gitActivity = view.gitActivity.length ? view.gitActivity : null;
				}
				this.agent.setFields(session.id, values);
			}
		} finally {
			repo.running = false;
		}
		if (repo.again) {
			repo.again = false;
			await this.read(root, repo);
		}
	}

	/** Stop following a repository that no open session is in any more. */
	private close(root: string, repo: Repo): void {
		clearTimeout(repo.timer);
		repo.stopWatching?.();
		this.repos.delete(root);
	}
}
