import { execFileSync } from "node:child_process";
import {
	closeSync,
	linkSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

/** A takeover that hasn't finished after this long was abandoned by a process that died. */
const STALE_TAKEOVER_MS = 10_000;

function quietUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}

/** The pid written in a lock, or undefined when there is no lock. */
export function lockHolder(path: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : 0;
	} catch {
		return undefined;
	}
}

/**
 * Whether `pid` is a running claude-lookout agent. A lock left by an agent that died may name a pid
 * the system has since given to another program, which must count as gone.
 */
export function isAgentProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	try {
		const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		return /\bnode\b/.test(args) && /\sagent$/.test(args);
	} catch {
		// `ps` exits non-zero once the process is gone.
		return false;
	}
}

/** Remove a lock whose holder is gone, unless someone else is already doing so. */
function removeStale(path: string, holder: number): boolean {
	const takeover = `${path}.takeover`;
	try {
		if (Date.now() - statSync(takeover).mtimeMs > STALE_TAKEOVER_MS) quietUnlink(takeover);
	} catch {}
	let fd: number;
	try {
		fd = openSync(takeover, "wx");
	} catch {
		return false;
	}
	try {
		// Only the lock that was judged stale; another agent may have taken it over meanwhile.
		if (lockHolder(path) === holder) quietUnlink(path);
		return true;
	} finally {
		closeSync(fd);
		quietUnlink(takeover);
	}
}

/**
 * Take the lock at `path` for this process, or return false while a live agent holds it. The lock
 * appears with the pid already in it, so nobody ever reads it half-written, and only one process
 * can replace a stale one.
 */
export function acquireLock(
	path: string,
	holderAlive: (pid: number) => boolean = isAgentProcess,
	pid = process.pid,
): boolean {
	const mine = `${path}.${pid}`;
	writeFileSync(mine, String(pid));
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				linkSync(mine, path);
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
			const holder = lockHolder(path);
			if (holder === undefined) continue;
			if (holder === pid) return true;
			if (holder > 0 && holderAlive(holder)) return false;
			if (!removeStale(path, holder)) return false;
		}
		return false;
	} finally {
		quietUnlink(mine);
	}
}

/** Give the lock back, if this process still holds it. */
export function releaseLock(path: string, pid = process.pid): void {
	if (lockHolder(path) === pid) quietUnlink(path);
}
