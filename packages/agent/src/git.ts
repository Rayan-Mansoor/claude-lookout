import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
