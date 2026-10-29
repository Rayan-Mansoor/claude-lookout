import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChanges, repoRoot } from "./git.ts";

const dirs: string[] = [];

function repo(): {
	dir: string;
	git: (...args: string[]) => string;
	write: (f: string, c: string) => void;
} {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookout-git-")));
	dirs.push(dir);
	// Keep the user's own git setup (signing, hooks) out of the way.
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
			{ cwd: dir, encoding: "utf8" },
		).trim();
	const write = (file: string, content: string) => writeFileSync(join(dir, file), content);
	git("init", "-q", "-b", "main");
	return { dir, git, write };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readChanges", () => {
	it("counts changed, new and deleted files with their lines", async () => {
		const { dir, git, write } = repo();
		write("a.txt", "1\n2\n3\n");
		write("gone.txt", "x\n");
		git("add", ".");
		git("commit", "-qm", "start");
		write("a.txt", "1\nchanged\n3\n4\n");
		write("new.txt", "one\ntwo\n");
		unlinkSync(join(dir, "gone.txt"));

		const changes = await readChanges(dir);
		expect(changes).toMatchObject({ total: 3, added: 4, removed: 2 });
		expect(changes?.files).toEqual([
			{ path: "a.txt", added: 2, removed: 1, status: "changed" },
			{ path: "new.txt", added: 2, removed: 0, status: "new" },
			{ path: "gone.txt", added: 0, removed: 1, status: "deleted" },
		]);
	});

	it("reports a clean tree as no changes", async () => {
		const { dir, git, write } = repo();
		write("a.txt", "1\n");
		git("add", ".");
		git("commit", "-qm", "start");
		expect(await readChanges(dir)).toEqual({ files: [], total: 0, added: 0, removed: 0 });
	});

	it("works before the first commit", async () => {
		const { dir, write } = repo();
		write("a.txt", "1\n2\n");
		expect(await readChanges(dir)).toMatchObject({ total: 1, added: 2 });
	});

	it("marks files a merge left in conflict", async () => {
		const { dir, git, write } = repo();
		write("a.txt", "1\n");
		git("add", ".");
		git("commit", "-qm", "start");
		git("checkout", "-qb", "other");
		write("a.txt", "theirs\n");
		git("commit", "-qam", "theirs");
		git("checkout", "-q", "main");
		write("a.txt", "ours\n");
		git("commit", "-qam", "ours");
		try {
			git("merge", "-q", "other");
		} catch {}
		expect((await readChanges(dir))?.files).toEqual([
			expect.objectContaining({ path: "a.txt", status: "conflict" }),
		]);
	});
});

describe("outside a repository", () => {
	it("finds no repository and no changes", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookout-plain-")));
		dirs.push(dir);
		mkdirSync(join(dir, "sub"));
		expect(await repoRoot(join(dir, "sub"))).toBeUndefined();
		expect(await readChanges(dir)).toBeUndefined();
	});
});
