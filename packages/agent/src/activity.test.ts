import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellRun } from "@claude-lookout/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ownerOf, RepoGit, type SessionGit } from "./activity.ts";

/** The session starts at T; commits before it are the project's history. */
const T = 1_800_000_000;
const NOW = (T + 10_000) * 1000;
const dirs: string[] = [];

/** A repository whose clock is set by hand, so reflog times are known. */
function repo(name = "w", parent = realpathSync(mkdtempSync(join(tmpdir(), "lookout-act-")))) {
	dirs.push(parent);
	const dir = join(parent, name);
	let clock = T - 1000;
	let editors = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				env: {
					...process.env,
					GIT_AUTHOR_DATE: `@${clock} +0000`,
					GIT_COMMITTER_DATE: `@${clock} +0000`,
					...editors,
				},
			},
		).trim();
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	let n = 0;
	const commit = (subject: string, file = `f${n++}`) => {
		writeFileSync(join(dir, file), `${subject}\n${n}\n`);
		git("add", file);
		git("commit", "-qm", subject);
	};
	/** Move the clock to `s` seconds after the session started. */
	const at = (s: number) => {
		clock = T + s;
	};
	/** Edit the next interactive rebase's todo list and messages with these commands. */
	const edit = (todo: string, message: string) => {
		editors = { GIT_EDITOR: message, GIT_SEQUENCE_EDITOR: todo };
	};
	return { dir, parent, git, commit, at, edit };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A shell command Claude ran from second `from` to second `to` of the session. */
const run = (from: number, to: number): ShellRun => ({
	start: (T + from) * 1000,
	end: (T + to) * 1000,
});

function session(id: string, shell: ShellRun[] = [run(0, 9000)]): SessionGit {
	return { id, since: T * 1000, shell };
}

async function view(dir: string, sessions: SessionGit[] = [session("s1")], id = "s1") {
	const repoGit = new RepoGit(dir);
	return (await repoGit.read(sessions, NOW)).get(id);
}

describe("RepoGit", () => {
	it("credits plain commits, newest first, with their size", async () => {
		const { dir, commit, at } = repo();
		commit("Before");
		at(10);
		commit("Add login");
		at(20);
		commit("Add logout");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 2, earlier: 0 });
		expect(v?.gitCommits.map((c) => c.subject)).toEqual(["Add logout", "Add login"]);
		expect(v?.gitCommits[0]).toMatchObject({ added: 2, removed: 0, files: 1 });
		expect(v?.gitActivity.map((e) => [e.kind, e.subject])).toEqual([
			["commit", "Add logout"],
			["commit", "Add login"],
		]);
	});

	it("shows a fixup folded into a commit from before the session as a rewrite, not new commits", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		commit("P2", "p2");
		commit("P3");
		at(10);
		commit("fixup! P2", "p2");
		at(20);
		git("rebase", "-q", "-i", "--autosquash", "HEAD~3");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 0, earlier: 2 });
		expect(v?.gitCommits.map((c) => [c.subject, c.earlier])).toEqual([
			["P3", true],
			["P2", true],
		]);
		expect(v?.gitActivity[0]).toMatchObject({
			kind: "rebase",
			count: 2,
			folded: ["P2"],
			earlier: true,
		});
		expect(v?.gitActivity[0]?.removed).toBeUndefined();
	});

	it("shows an amend of the commit the session started on as a rewrite", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		commit("P2");
		at(10);
		writeFileSync(join(dir, "extra"), "x\n");
		git("add", "extra");
		git("commit", "-q", "--amend", "--no-edit");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 0, earlier: 1 });
		expect(v?.gitActivity).toEqual([
			expect.objectContaining({ kind: "amend", subject: "P2", earlier: true }),
		]);
	});

	it("keeps an amended commit of the session's own as one new commit", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		at(10);
		commit("Add b");
		at(20);
		git("commit", "-q", "--amend", "-m", "Add b, reworded");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 1, earlier: 0 });
		expect(v?.gitCommits.map((c) => c.subject)).toEqual(["Add b, reworded"]);
		expect(v?.gitActivity[0]).toMatchObject({ kind: "amend", subject: "Add b, reworded" });
		expect(v?.gitActivity[0]?.earlier).toBeUndefined();
	});

	it("tells reworded and dropped commits apart in a rebase", async () => {
		const { dir, git, commit, at, edit } = repo();
		commit("P1");
		at(10);
		commit("A");
		commit("B");
		commit("C");
		at(20);
		edit("sed -i.bak -e '1s/^pick/reword/' -e '2s/^pick/drop/'", "sed -i.bak '1s/.*/A, reworded/'");
		git("rebase", "-q", "-i", "HEAD~3");
		const v = await view(dir);
		expect(v?.gitActivity[0]).toMatchObject({ kind: "rebase", count: 2, reworded: 1, removed: 1 });
		expect(v?.gitCommits.map((c) => c.subject)).toEqual(["C", "A, reworded"]);
	});

	it("shows a rebase that was quit as stopped, and what came after on its own", async () => {
		const { dir, git, commit, at, edit } = repo();
		commit("P1");
		at(10);
		commit("A");
		commit("B");
		at(20);
		edit("sed -i.bak '1s/^pick/edit/'", "true");
		git("rebase", "-q", "-i", "HEAD~2");
		git("rebase", "--quit");
		at(30);
		commit("After");
		const v = await view(dir);
		expect(v?.gitActivity.map((e) => e.kind)).toEqual(["commit", "rebase", "commit", "commit"]);
		expect(v?.gitActivity[1]).toMatchObject({ kind: "rebase", aborted: true });
		expect(v?.gitCommits[0]?.subject).toBe("After");
	});

	it("doesn't credit commits a rebase brought in from the branch it moved onto", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		git("checkout", "-qb", "feat");
		commit("F1");
		git("checkout", "-q", "main");
		commit("M1");
		commit("M2");
		git("checkout", "-q", "feat");
		at(10);
		git("rebase", "-q", "main");
		const v = await view(dir);
		expect(v?.gitActivity[0]).toMatchObject({ kind: "rebase", ref: "main", count: 1 });
		expect(v?.gitCommits.map((c) => c.subject)).toEqual(["F1"]);
		expect(v?.git).toEqual({ commits: 0, earlier: 1 });
	});

	it("counts merged, pulled and switched-to commits as activity, not as the session's commits", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		git("checkout", "-qb", "other");
		commit("O1");
		commit("O2");
		git("checkout", "-q", "main");
		at(10);
		git("merge", "-q", "other");
		at(20);
		git("checkout", "-q", "-b", "side");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 0, earlier: 0 });
		expect(v?.gitActivity.map((e) => [e.kind, e.ref, e.count, e.fastForward])).toEqual([
			["switch", "side", undefined, undefined],
			["merge", "other", 2, true],
		]);
		expect(v?.gitActivity[0]?.from).toBe("main");
	});

	it("credits the merge commit of a real merge", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		git("checkout", "-qb", "other");
		commit("O1");
		git("checkout", "-q", "main");
		commit("M1");
		at(10);
		git("merge", "-q", "--no-edit", "other");
		const v = await view(dir);
		expect(v?.gitActivity[0]).toMatchObject({ kind: "merge", ref: "other", count: 1 });
		expect(v?.gitCommits.map((c) => c.subject)).toEqual(["Merge branch 'other'"]);
	});

	it("lists the commits a reset dropped", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		at(10);
		commit("A");
		commit("B");
		at(20);
		git("reset", "-q", "--hard", "HEAD~2");
		const v = await view(dir);
		expect(v?.git).toEqual({ commits: 0, earlier: 0 });
		expect(v?.gitActivity[0]).toMatchObject({
			kind: "reset",
			ref: "HEAD~2",
			count: 2,
			dropped: ["B", "A"],
		});
	});

	it("credits only the session whose command ran, and marks the rest", async () => {
		const { dir, commit, at } = repo();
		commit("P1");
		at(10);
		commit("By s1");
		at(30);
		commit("By s2");
		at(50);
		commit("By you");
		const sessions = [session("s1", [run(5, 15)]), session("s2", [run(25, 35)])];
		const s1 = await view(dir, sessions, "s1");
		const s2 = await view(dir, sessions, "s2");
		expect(s1?.gitCommits.map((c) => c.subject)).toEqual(["By s1"]);
		expect(s2?.gitCommits.map((c) => c.subject)).toEqual(["By s2"]);
		expect(s1?.gitActivity.map((e) => [e.subject, e.by])).toEqual([
			["By you", "you"],
			["By s2", "other"],
			["By s1", undefined],
		]);
	});

	it("doesn't credit work done in the second after a command returned", async () => {
		const { dir, commit, at } = repo();
		commit("P1");
		at(10);
		commit("By Claude");
		at(11);
		commit("By you");
		const shell = [{ start: (T + 10) * 1000 + 100, end: (T + 10) * 1000 + 600 }];
		const v = await view(dir, [session("s1", shell)]);
		expect(v?.gitActivity.map((e) => [e.subject, e.by])).toEqual([
			["By you", "you"],
			["By Claude", undefined],
		]);
	});

	it("shows nothing from before the session started", async () => {
		const { dir, commit } = repo();
		commit("P1");
		commit("P2");
		const v = await view(dir);
		expect(v).toEqual({ git: { commits: 0, earlier: 0 }, gitCommits: [], gitActivity: [] });
	});

	it("follows pushes, fetches and what is still unpushed", async () => {
		const { parent, dir, git, commit, at } = repo();
		execFileSync("git", ["init", "-q", "--bare", join(parent, "remote.git")]);
		commit("P1");
		git("remote", "add", "origin", "../remote.git");
		git("push", "-q", "-u", "origin", "main");
		at(10);
		commit("A");
		commit("B");
		at(20);
		git("push", "-q");
		at(30);
		commit("C");
		const v = await view(dir);
		expect(v?.git).toEqual({
			commits: 3,
			earlier: 0,
			unpushed: 1,
			upstream: { ref: "origin/main", ahead: 1, behind: 0 },
		});
		expect(v?.gitCommits.map((c) => [c.subject, c.unpushed])).toEqual([
			["C", true],
			["B", undefined],
			["A", undefined],
		]);
		expect(v?.gitActivity[1]).toMatchObject({ kind: "push", ref: "origin/main", count: 2 });
	});

	it("notices branches, tags and stashes that come and go between reads", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1");
		const repoGit = new RepoGit(dir);
		const sessions = [session("s1")];
		await repoGit.read(sessions, NOW);
		at(10);
		git("branch", "topic");
		git("tag", "v1");
		writeFileSync(join(dir, "f0"), "dirty\n");
		git("stash", "-q");
		const v = (await repoGit.read(sessions, NOW))?.get("s1");
		expect(v?.gitActivity.map((e) => [e.kind, e.ref ?? e.count])).toEqual(
			expect.arrayContaining([
				["branch-created", "topic"],
				["tag-created", "v1"],
				["stash", 1],
			]),
		);
		git("branch", "-D", "-q", "topic");
		const after = (await repoGit.read(sessions, NOW))?.get("s1");
		expect(after?.gitActivity[0]).toMatchObject({ kind: "branch-deleted", ref: "topic" });
	});

	it("reports a rebase stopped on a conflict", async () => {
		const { dir, git, commit, at } = repo();
		commit("P1", "a");
		git("checkout", "-qb", "feat");
		commit("F1", "a");
		git("checkout", "-q", "main");
		commit("M1", "a");
		git("checkout", "-q", "feat");
		at(10);
		try {
			git("rebase", "-q", "main");
		} catch {}
		const v = await view(dir);
		expect(v?.git.busy).toEqual({ kind: "rebase", step: 1, total: 1 });
		expect(v?.gitActivity[0]).toMatchObject({ kind: "rebase", ref: "main", running: true });
	});
});

describe("ownerOf", () => {
	const minute = 60_000;
	const devServer = { id: "s1", since: 0, shell: [{ start: 0, background: true as const }] };
	const pusher = {
		id: "s2",
		since: 0,
		shell: [{ start: 0, background: true as const, git: true as const }],
	};

	it("credits a command left in the background for as long as a foreground one could run", () => {
		expect(ownerOf([devServer], 5 * minute, 5 * minute, 6 * minute)).toBe("s1");
	});

	it("stops crediting a background command that doesn't run git after that", () => {
		expect(ownerOf([devServer], 60 * minute, 60 * minute, 61 * minute)).toBeUndefined();
	});

	it("keeps crediting a background command that runs git for all of its run", () => {
		expect(ownerOf([pusher], 60 * minute, 60 * minute, 61 * minute)).toBe("s2");
	});
});
