import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { defaultConfig, loadConfig } from "./config.ts";
import { paths } from "./home.ts";
import { renderStatus } from "./status.ts";

function makeAgent(level: 1 | 2 = 2) {
	let now = 1_000_000;
	const agent = new Agent(
		{ machine: { id: "m1", name: "Studio" }, level },
		{ gitBranch: () => "main" },
		() => now,
	);
	const send = (input: Partial<HookInput>) => {
		now += 1000;
		agent.handle({ input: { session_id: "s1", cwd: "/w/api", ...input } as HookInput, at: now });
	};
	return { agent, send, advance: (ms: number) => (now += ms) };
}

describe("Agent", () => {
	it("publishes snapshots on every change", () => {
		const { agent, send } = makeAgent();
		const seen: string[] = [];
		agent.onChange((snap) => seen.push(snap.sessions[0]?.state ?? "none"));
		send({ hook_event_name: "SessionStart", source: "startup" });
		send({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
		send({ hook_event_name: "Stop" });
		expect(seen).toEqual(["ready", "working", "finished"]);
	});

	it("respects the configured exposure level", () => {
		const { agent, send } = makeAgent(1);
		send({ hook_event_name: "UserPromptSubmit", prompt: "private" });
		expect(agent.snapshot().sessions[0]?.fields).toEqual({
			project: "api",
			cwd: "/w/api",
			branch: "main",
		});
	});

	it("is idle only when every session has closed, and prunes old ones", () => {
		const { agent, send, advance } = makeAgent();
		send({ hook_event_name: "SessionStart", source: "startup" });
		expect(agent.idle()).toBe(false);
		send({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
		expect(agent.idle()).toBe(true);
		agent.prune();
		expect(agent.sessions.size).toBe(1);
		advance(31 * 60_000);
		agent.prune();
		expect(agent.sessions.size).toBe(0);
	});
});

describe("renderStatus", () => {
	it("lists open sessions with state, age and activity", () => {
		const { agent, send } = makeAgent();
		send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
		const text = renderStatus(agent.snapshot(), agent.snapshot().sentAt + 65_000);
		expect(text).toBe("Studio\n  Working     1m  api (main) · Bash npm test");
	});

	it("says so when nothing is open", () => {
		expect(renderStatus(undefined)).toBe("No Claude Code sessions are open.");
	});
});

describe("config file", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "lookout-config-"));

	it("starts fresh only when there is no config yet", () => {
		expect(loadConfig(join(dir(), "config.json")).machine.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("keeps what was saved", () => {
		const path = join(dir(), "config.json");
		const saved = defaultConfig();
		writeFileSync(path, JSON.stringify(saved));
		expect(loadConfig(path).machine).toEqual(saved.machine);
	});

	it("refuses a damaged config instead of replacing its secrets", () => {
		const path = join(dir(), "config.json");
		writeFileSync(path, '{"machine": {"id": "abc"');
		expect(() => loadConfig(path)).toThrow(/damaged/);
		writeFileSync(path, "[]");
		expect(() => loadConfig(path)).toThrow(/damaged/);
	});
});

describe("agent socket", () => {
	it("falls back to a folder only this user can enter when the home path is too long", () => {
		const before = process.env.CLAUDE_LOOKOUT_HOME;
		process.env.CLAUDE_LOOKOUT_HOME = join(tmpdir(), "x".repeat(120));
		try {
			const socket = paths.socket();
			expect(Buffer.byteLength(socket)).toBeLessThan(104);
			const dir = join(socket, "..");
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			expect(statSync(dir).uid).toBe(userInfo().uid);
		} finally {
			if (before === undefined) delete process.env.CLAUDE_LOOKOUT_HOME;
			else process.env.CLAUDE_LOOKOUT_HOME = before;
		}
	});
});

describe("Claude Code process", () => {
	it("tries a failed lookup again on the next event, and keeps one that worked", () => {
		const answers: (number | undefined)[] = [undefined, 4242];
		let lookups = 0;
		const agent = new Agent(
			{ machine: { id: "m1", name: "Studio" }, level: 2 },
			{ gitBranch: () => "main" },
			() => 1,
			() => {
				lookups++;
				return answers.shift();
			},
		);
		const event = (name: string) => ({
			input: { session_id: "s1", hook_event_name: name } as HookInput,
			at: 1,
			pid: 77,
		});
		agent.handle(event("SessionStart"));
		expect(agent.sessions.get("s1")?.pid).toBeUndefined();
		agent.handle(event("UserPromptSubmit"));
		agent.handle(event("Stop"));
		expect(agent.sessions.get("s1")?.pid).toBe(4242);
		expect(lookups).toBe(2);
	});
});
