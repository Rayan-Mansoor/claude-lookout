import type { HookInput, WorkingChanges } from "@claude-lookout/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitView, SessionGit } from "./activity.ts";
import { Agent } from "./agent.ts";
import { defaultConfig } from "./config.ts";
import { type ProgressGit, ProgressTracker } from "./progress.ts";

const CHANGES: WorkingChanges = {
	files: [{ path: "src/a.ts", added: 3, removed: 1, status: "changed" }],
	total: 1,
	added: 3,
	removed: 1,
};

function viewOf(session: SessionGit): GitView {
	const mine = session.shell.length;
	return {
		git: { commits: mine, earlier: 0 },
		gitCommits: Array.from({ length: mine }, (_, i) => ({
			sha: `abc${i}`,
			subject: `Commit ${i}`,
			added: 1,
			removed: 0,
			files: 1,
		})),
		gitActivity: [],
	};
}

function setup() {
	const agent = new Agent(
		{ ...defaultConfig(), machine: { id: "m1", name: "Studio" } },
		{ gitBranch: () => "main" },
	);
	const read = vi.fn(
		async (sessions: SessionGit[]) =>
			new Map(sessions.filter((s) => !s.gone).map((s) => [s.id, viewOf(s)])),
	);
	const git = {
		repoRoot: vi.fn(
			async (cwd: string): Promise<string | undefined> =>
				cwd.startsWith("/w/api") ? "/w/api" : undefined,
		),
		readChanges: vi.fn(async () => CHANGES),
		openRepo: vi.fn(() => ({ read })),
	} satisfies ProgressGit;
	const tracker = new ProgressTracker(agent, git, 2000);
	tracker.start();
	const send = (session: string, input: Partial<HookInput>, cwd = "/w/api") =>
		agent.handle({ input: { session_id: session, cwd, ...input } as HookInput, at: Date.now() });
	return { agent, git, read, send };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ProgressTracker", () => {
	it("reads git once after a burst of edits", async () => {
		const { agent, git, read, send } = setup();
		send("s1", { hook_event_name: "SessionStart", source: "startup" });
		for (let i = 0; i < 5; i++) {
			send("s1", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} });
			await vi.advanceTimersByTimeAsync(500);
		}
		await vi.advanceTimersByTimeAsync(2000);
		expect(git.readChanges).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledTimes(1);
		expect(agent.sessions.get("s1")?.fields.changes).toEqual(CHANGES);
	});

	it("looks again at a folder that wasn't a repository, as after `git init`", async () => {
		const { agent, git, send } = setup();
		let initialised = false;
		git.repoRoot.mockImplementation(async (cwd: string) =>
			initialised && cwd === "/w/new" ? "/w/new" : undefined,
		);
		const edit = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} };
		send("s1", edit, "/w/new");
		await vi.advanceTimersByTimeAsync(3000);
		initialised = true;
		send("s1", edit, "/w/new");
		await vi.advanceTimersByTimeAsync(3000);
		expect(agent.sessions.get("s1")?.fields.changes).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		send("s1", edit, "/w/new");
		await vi.advanceTimersByTimeAsync(3000);
		expect(agent.sessions.get("s1")?.fields.changes).toEqual(CHANGES);
	});

	it("keeps what it showed when a git read fails", async () => {
		const { agent, git, read, send } = setup();
		send("s1", { hook_event_name: "SessionStart", source: "startup" });
		await vi.advanceTimersByTimeAsync(3000);
		git.readChanges.mockImplementation(async () => undefined as unknown as WorkingChanges);
		read.mockImplementation(async () => {
			throw new Error("git did not answer");
		});
		send("s1", { hook_event_name: "Stop" });
		await vi.advanceTimersByTimeAsync(3000);
		expect(agent.sessions.get("s1")?.fields.changes).toEqual(CHANGES);
	});

	it("ignores events that can't change the repository", async () => {
		const { git, send } = setup();
		send("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} });
		send("s1", { hook_event_name: "UserPromptSubmit", prompt: "hi" });
		await vi.advanceTimersByTimeAsync(3000);
		expect(git.readChanges).not.toHaveBeenCalled();
	});

	it("hands every session in a repository its own shell commands and shows each its own view", async () => {
		const { agent, git, read, send } = setup();
		send("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
		send("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" });
		send("s2", { hook_event_name: "SessionStart", source: "startup" }, "/w/api/web");
		await vi.advanceTimersByTimeAsync(2000);
		expect(git.openRepo).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[0].map((s) => [s.id, s.shell.length])).toEqual([
			["s1", 1],
			["s2", 0],
		]);
		expect(agent.sessions.get("s1")?.fields).toMatchObject({
			git: { commits: 1, earlier: 0 },
			gitCommits: [expect.objectContaining({ subject: "Commit 0" })],
		});
		// Nothing to show is shown as nothing.
		expect(agent.sessions.get("s2")?.fields.git).toBeUndefined();
		expect(agent.sessions.get("s2")?.fields.gitCommits).toBeUndefined();
		expect(agent.sessions.get("s2")?.fields.changes).toEqual(CHANGES);
	});

	it("leaves sessions outside git alone", async () => {
		const { agent, git, send } = setup();
		send("s1", { hook_event_name: "Stop" }, "/tmp/notes");
		await vi.advanceTimersByTimeAsync(3000);
		expect(git.readChanges).not.toHaveBeenCalled();
		expect(agent.sessions.get("s1")?.fields.changes).toBeUndefined();
	});
});
