import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { BLOCKED_STATES, type Session } from "@claude-lookout/protocol";

const TAIL_BYTES = 64 * 1024;
/** A session whose Claude Code process was never found counts as closed after this long quiet. */
const UNKNOWN_PROCESS_TTL_MS = 12 * 60 * 60_000;
const INTERRUPT_MARKER = "[Request interrupted by user";
/** Fields that describe a run in progress and mean nothing once it was interrupted. */
const RUN_FIELDS = ["activity", "permission", "questions", "plan"];

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The Claude Code process behind a hook. Hooks normally run as direct children of Claude Code,
 * but a wrapper may sit in between, so walk up a few parents looking for it. Returns undefined
 * when it can't be found, so a session is never marked closed because of the wrong process.
 */
export function findClaudePid(pid: number): number | undefined {
	let current = pid;
	for (let depth = 0; depth < 4; depth++) {
		let line: string;
		try {
			line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(current)], {
				encoding: "utf8",
			}).trim();
		} catch {
			return undefined;
		}
		const match = line.match(/^(\d+)\s+(.+)$/);
		if (!match) return undefined;
		if (isClaude(match[2] ?? "")) return current;
		current = Number(match[1]);
		if (current <= 1) return undefined;
	}
	return undefined;
}

const isClaude = (comm: string) => /claude/i.test(basename(comm));

/**
 * Which of these pids still belong to a running Claude Code, in one `ps` call. A pid left over from
 * a Claude Code that exited (say, before a restart) may now belong to another program, which must
 * not keep its session open. Undefined when `ps` can't tell.
 */
export function runningClaudes(pids: number[]): Set<number> | undefined {
	if (pids.length === 0) return new Set();
	let out: string;
	try {
		out = execFileSync("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], {
			encoding: "utf8",
			timeout: 2000,
		});
	} catch (err) {
		// `ps` exits 1 with nothing to print when none of the pids is running.
		const failed = err as { status?: number; stdout?: string };
		if (failed.status !== 1 || failed.stdout?.trim()) return undefined;
		out = "";
	}
	const running = new Set<number>();
	for (const line of out.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(.+)$/);
		if (match && isClaude(match[2] ?? "")) running.add(Number(match[1]));
	}
	return running;
}

function readTail(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function entryText(entry: Record<string, unknown>): string {
	const message = entry.message as { content?: unknown } | undefined;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? (part.text as string) : ""))
		.join("");
}

/**
 * When the last conversational entry of a transcript tail is Claude Code's interrupt marker,
 * the time it was written; otherwise undefined.
 */
export function interruptedAt(tail: string): number | undefined {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // the first line of a tail is usually cut mid-entry
		}
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		if (entry.type === "user" && entryText(entry).startsWith(INTERRUPT_MARKER)) {
			const at = Date.parse(String(entry.timestamp));
			return Number.isNaN(at) ? Date.now() : at;
		}
		return undefined;
	}
	return undefined;
}

/**
 * Catch what hooks don't report: a run stopped with Esc fires no Stop hook, and a closed
 * terminal may not fire SessionEnd. Returns the sessions whose state changed.
 */
export function checkSessions(
	sessions: Iterable<Session>,
	now: number,
	claudes: (pids: number[]) => Set<number> | undefined = runningClaudes,
): Session[] {
	const changed: Session[] = [];
	const open = [...sessions].filter((s) => s.state !== "gone");
	const pids = open.flatMap((s) => (s.pid === undefined ? [] : [s.pid]));
	const running = claudes(pids);
	const alive = (pid: number) => (running ? running.has(pid) : isAlive(pid));
	for (const session of open) {
		const closed =
			session.pid === undefined
				? now - session.updatedAt > UNKNOWN_PROCESS_TTL_MS
				: !alive(session.pid);
		if (closed) {
			const { blocks: _, ...rest } = session;
			changed.push({ ...rest, state: "gone", since: now, updatedAt: now });
			continue;
		}
		const running = session.state === "working" || BLOCKED_STATES.includes(session.state);
		if (!running || !session.transcript) continue;
		const tail = readTail(session.transcript);
		const at = tail ? interruptedAt(tail) : undefined;
		if (at !== undefined && at >= session.since) {
			const fields = { ...session.fields };
			for (const key of RUN_FIELDS) delete fields[key];
			// Whatever was waiting on you went away with the run.
			const { blocks: _, ...rest } = session;
			changed.push({ ...rest, state: "interrupted", since: at, updatedAt: now, fields });
		}
	}
	return changed;
}
