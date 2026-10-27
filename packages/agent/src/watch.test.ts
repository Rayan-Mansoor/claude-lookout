import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import { checkSessions, findClaudePid, interruptedAt } from "./watch.ts";

const DEAD_PID = 2 ** 22 - 7;

const user = (text: string, timestamp: string) =>
	JSON.stringify({ type: "user", timestamp, message: { content: [{ type: "text", text }] } });
const assistant = (timestamp: string) =>
	JSON.stringify({
		type: "assistant",
		timestamp,
		message: { content: [{ type: "text", text: "ok" }] },
	});

describe("interruptedAt", () => {
	it("finds an interrupt that ends the transcript", () => {
		const tail = [
			'cut-off": "partial line',
			assistant("2026-10-27T10:00:00.000Z"),
			user("[Request interrupted by user for tool use]", "2026-10-27T10:00:05.000Z"),
			JSON.stringify({ type: "system", subtype: "info" }),
		].join("\n");
		expect(interruptedAt(tail)).toBe(Date.parse("2026-10-27T10:00:05.000Z"));
	});

	it("ignores an interrupt the conversation has moved past", () => {
		const tail = [
			user("[Request interrupted by user]", "2026-10-27T10:00:05.000Z"),
			user("try again", "2026-10-27T10:01:00.000Z"),
		].join("\n");
		expect(interruptedAt(tail)).toBeUndefined();
	});
});

function session(overrides: Partial<Session>): Session {
	return {
		id: "s",
		state: "working",
		since: Date.parse("2026-10-27T10:00:00.000Z"),
		startedAt: 0,
		updatedAt: 0,
		fields: { project: "api", activity: { tool: "Bash" } },
		...overrides,
	};
}

describe("checkSessions", () => {
	it("marks a session gone when its Claude Code process has exited", () => {
		const [changed] = checkSessions([session({ pid: DEAD_PID })], 5);
		expect(changed).toMatchObject({ state: "gone", since: 5 });
	});

	it("leaves live sessions alone", () => {
		const claudes = () => new Set([process.pid]);
		expect(checkSessions([session({ pid: process.pid })], 5, claudes)).toEqual([]);
	});

	it("closes a session whose pid now belongs to another program", () => {
		// This test runner is alive, but it isn't Claude Code.
		const [changed] = checkSessions([session({ pid: process.pid })], 5);
		expect(changed).toMatchObject({ state: "gone" });
	});

	it("falls back to whether the pid is alive when `ps` can't tell", () => {
		expect(checkSessions([session({ pid: process.pid })], 5, () => undefined)).toEqual([]);
	});

	it("closes a session without a known process only after a long quiet", () => {
		const quiet = session({ updatedAt: 0 });
		expect(checkSessions([quiet], 11 * 60 * 60_000)).toEqual([]);
		expect(checkSessions([quiet], 13 * 60 * 60_000)[0]).toMatchObject({ state: "gone" });
	});

	it("marks an interrupted run and drops its in-progress fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-"));
		const transcript = join(dir, "t.jsonl");
		writeFileSync(
			transcript,
			`${user("[Request interrupted by user]", "2026-10-27T10:00:09.000Z")}\n`,
		);
		const [changed] = checkSessions([session({ transcript })], 99);
		expect(changed?.state).toBe("interrupted");
		expect(changed?.since).toBe(Date.parse("2026-10-27T10:00:09.000Z"));
		expect(changed?.fields).toEqual({ project: "api" });
	});

	it("ignores an interrupt from before the current run", () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-"));
		const transcript = join(dir, "t.jsonl");
		writeFileSync(
			transcript,
			`${user("[Request interrupted by user]", "2026-10-27T09:00:00.000Z")}\n`,
		);
		expect(checkSessions([session({ transcript })], 99)).toEqual([]);
	});
});

describe("findClaudePid", () => {
	it("gives up rather than guessing", () => {
		expect(findClaudePid(DEAD_PID)).toBeUndefined();
	});
});
