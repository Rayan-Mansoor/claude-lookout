import { describe, expect, it } from "vitest";
import type { FieldContext, Question } from "./fields.ts";
import type { HookInput } from "./hooks.ts";
import { reduce, type Session } from "./session.ts";
import { buildSnapshot } from "./snapshot.ts";

const ctx: FieldContext = { gitBranch: () => "main" };

function run(inputs: Partial<HookInput>[]): Session {
	let session: Session | undefined;
	inputs.forEach((partial, i) => {
		const input = { session_id: "s1", cwd: "/work/app", ...partial } as HookInput;
		session = reduce(session, { input, at: 1000 + i, pid: 42 }, ctx);
	});
	if (!session) throw new Error("no events");
	return session;
}

describe("session state", () => {
	it("starts ready with context fields", () => {
		const s = run([
			{ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" },
		]);
		expect(s.state).toBe("ready");
		expect(s.pid).toBe(42);
		expect(s.fields).toMatchObject({
			project: "app",
			branch: "main",
			model: "claude-opus-5-5",
			startedFrom: "startup",
		});
	});

	it("tracks a run through a permission prompt to the end", () => {
		const bash = { tool_name: "Bash", tool_input: { command: "npm test" } };
		const steps: [Partial<HookInput>, string][] = [
			[{ hook_event_name: "UserPromptSubmit", prompt: "run the tests" }, "working"],
			[{ hook_event_name: "PreToolUse", ...bash }, "working"],
			[{ hook_event_name: "PermissionRequest", ...bash }, "permission"],
			[{ hook_event_name: "PostToolUse", ...bash }, "working"],
			[{ hook_event_name: "Stop", last_assistant_message: "All tests pass." }, "finished"],
		];
		const states = steps.map((_, i) => run(steps.slice(0, i + 1).map(([e]) => e)).state);
		expect(states).toEqual(steps.map(([, state]) => state));

		const s = run(steps.map(([e]) => e));
		expect(s.fields.prompt).toBe("run the tests");
		expect(s.fields.lastMessage).toBe("All tests pass.");
		expect(s.fields.permission).toBeUndefined();
		expect(s.fields.activity).toBeUndefined();
	});

	it("keeps the permission request while blocked", () => {
		const s = run([
			{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf dist" } },
			{
				hook_event_name: "PermissionRequest",
				tool_name: "Bash",
				tool_input: { command: "rm -rf dist" },
				permission_suggestions: [{ rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }] }],
			},
		]);
		expect(s.state).toBe("permission");
		expect(s.fields.permission).toEqual({
			tool: "Bash",
			target: "rm -rf dist",
			detail: "rm -rf dist",
			suggestions: ["Bash(rm -rf dist)"],
		});
	});

	it("shows questions and plans as their own blocked states", () => {
		const asking = run([
			{
				hook_event_name: "PreToolUse",
				tool_name: "AskUserQuestion",
				tool_input: {
					questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres" }] }],
				},
			},
		]);
		expect(asking.state).toBe("question");
		expect(asking.fields.questions).toEqual([
			{ question: "Which DB?", header: "DB", options: [{ label: "Postgres" }], multiSelect: false },
		]);

		const planning = run([
			{
				hook_event_name: "PreToolUse",
				tool_name: "ExitPlanMode",
				tool_input: { plan: "1. Do it" },
			},
		]);
		expect(planning.state).toBe("plan");
		expect(planning.fields.plan).toBe("1. Do it");
	});

	it("keeps what each option means and its preview", () => {
		const asking = run([
			{
				hook_event_name: "PreToolUse",
				tool_name: "AskUserQuestion",
				tool_input: {
					questions: [
						{
							question: "Which layout?",
							options: [
								{ label: "Sidebar", description: "Nav on the left", preview: "|nav| main |" },
								{ label: "Tabs" },
							],
						},
					],
				},
			},
		]);
		expect((asking.fields.questions as Question[])[0]?.options).toEqual([
			{ label: "Sidebar", description: "Nav on the left", preview: "|nav| main |" },
			{ label: "Tabs" },
		]);
	});

	it("only moves `since` when the state changes", () => {
		const s = run([
			{ hook_event_name: "UserPromptSubmit", prompt: "go" },
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "/work/app/a.ts" },
			},
		]);
		expect(s.since).toBe(1000);
		expect(s.updatedAt).toBe(1001);
		expect(s.fields.activity).toEqual({ tool: "Read", target: "a.ts" });
	});

	it("tracks subagents and task progress", () => {
		const s = run([
			{ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" },
			{ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Plan" },
			{ hook_event_name: "SubagentStop", agent_id: "a1" },
			{
				hook_event_name: "PreToolUse",
				tool_name: "TodoWrite",
				tool_input: {
					todos: [
						{ content: "a", status: "completed" },
						{ content: "b", activeForm: "Doing b", status: "in_progress" },
						{ content: "c", status: "pending" },
					],
				},
			},
		]);
		expect(s.fields.subagents).toEqual([{ id: "a2", type: "Plan" }]);
		expect(s.fields.tasks).toEqual({ total: 3, done: 1, current: "Doing b" });
	});

	it("stays blocked while another call finishes, until the blocked call itself does", () => {
		const fetch = { tool_name: "WebFetch", tool_input: { url: "https://example.com" } };
		const read = { tool_name: "Read", tool_input: { file_path: "/work/app/a.ts" } };
		const base: Partial<HookInput>[] = [
			{ hook_event_name: "UserPromptSubmit", prompt: "go" },
			{ hook_event_name: "PreToolUse", ...read },
			{ hook_event_name: "PreToolUse", ...fetch },
			{ hook_event_name: "PermissionRequest", ...fetch },
			{ hook_event_name: "PostToolUse", ...read },
		];
		expect(run(base).state).toBe("permission");
		const answered = run([...base, { hook_event_name: "PostToolUse", ...fetch }]);
		expect(answered.state).toBe("working");
		expect(answered.blocks).toBeUndefined();
	});

	it("keeps a subagent's request when another subagent carries on", () => {
		const bash = { tool_name: "Bash", tool_input: { command: "rm -rf dist" } };
		const base: Partial<HookInput>[] = [
			{ hook_event_name: "PermissionRequest", agent_id: "a1", ...bash },
			{ hook_event_name: "PreToolUse", agent_id: "a2", tool_name: "Grep", tool_input: {} },
			{ hook_event_name: "PostToolUse", agent_id: "a2", tool_name: "Grep", tool_input: {} },
		];
		expect(run(base).state).toBe("permission");
		expect(run([...base, { hook_event_name: "SubagentStop", agent_id: "a1" }]).state).toBe(
			"working",
		);
	});

	it("shows the newest of several requests and falls back to the older one", () => {
		const bash = { tool_name: "Bash", tool_input: { command: "npm publish" } };
		const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
		const base: Partial<HookInput>[] = [
			{ hook_event_name: "PermissionRequest", agent_id: "a1", ...bash },
			{ hook_event_name: "PreToolUse", ...ask },
		];
		expect(run(base).state).toBe("question");
		expect(run([...base, { hook_event_name: "PostToolUse", ...ask }]).state).toBe("permission");
	});

	it("ends a request when the same agent starts another call, as after a refusal", () => {
		const s = run([
			{ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } },
			{ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
		]);
		expect(s.state).toBe("working");
	});

	it("matches a call whose input a hook changed by its tool", () => {
		const s = run([
			{ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "a" } },
			{ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a --safe" } },
		]);
		expect(s.state).toBe("working");
	});

	it("clears every request when the run stops or you type", () => {
		const ask = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} };
		expect(run([ask, { hook_event_name: "Stop" }])).toMatchObject({ state: "finished" });
		expect(run([ask, { hook_event_name: "Stop" }]).blocks).toBeUndefined();
		expect(run([ask, { hook_event_name: "UserPromptSubmit", prompt: "no" }]).state).toBe("working");
	});

	it("ignores the state of an event that arrives after a later one", () => {
		let s = reduce(
			undefined,
			{ input: { hook_event_name: "Stop", session_id: "s1" } as HookInput, at: 2000 },
			ctx,
		);
		s = reduce(
			s,
			{
				input: {
					hook_event_name: "PostToolUse",
					session_id: "s1",
					tool_name: "Read",
					tool_input: {},
				} as HookInput,
				at: 1990,
			},
			ctx,
		);
		expect(s).toMatchObject({ state: "finished", since: 2000 });
	});

	it("marks closed sessions gone", () => {
		expect(run([{ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }]).state).toBe(
			"gone",
		);
	});
});

describe("shell commands", () => {
	const bash = (event: string, id: string, input: Record<string, unknown> = {}) =>
		({
			hook_event_name: event,
			tool_name: "Bash",
			tool_use_id: id,
			tool_input: { command: "git commit", ...input },
		}) as Partial<HookInput>;

	it("notes when each one starts and returns", () => {
		const s = run([bash("PreToolUse", "t1"), bash("PostToolUse", "t1"), bash("PreToolUse", "t2")]);
		expect(s.shell).toEqual([
			{ id: "t1", start: 1000, end: 1001 },
			{ id: "t2", start: 1002 },
		]);
	});

	it("ends every command still running when the run stops", () => {
		const s = run([bash("PreToolUse", "t1"), { hook_event_name: "Stop" }]);
		expect(s.shell).toEqual([{ id: "t1", start: 1000, end: 1001 }]);
	});

	it("ends a failed or refused command", () => {
		const s = run([
			bash("PreToolUse", "t1"),
			bash("PostToolUseFailure", "t1"),
			bash("PreToolUse", "t2"),
			bash("PermissionDenied", "t2"),
		]);
		expect(s.shell?.map((r) => r.end)).toEqual([1001, 1003]);
	});
});

describe("edited files", () => {
	const edit = (file: string, tool = "Edit"): Partial<HookInput> => ({
		hook_event_name: "PostToolUse",
		tool_name: tool,
		tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file },
	});

	it("lists files relative to the folder, newest first, without repeats", () => {
		const s = run([
			edit("/work/app/src/a.ts"),
			edit("/work/app/b.md", "Write"),
			edit("/work/app/src/a.ts", "MultiEdit"),
			edit("/elsewhere/c.ipynb", "NotebookEdit"),
			{
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: "/work/app/r" },
			},
		]);
		expect(s.fields.edited).toEqual(["/elsewhere/c.ipynb", "src/a.ts", "b.md"]);
	});

	it("keeps the 50 most recent and starts over after /clear", () => {
		const many = Array.from({ length: 60 }, (_, i) => edit(`/work/app/f${i}.ts`));
		const s = run(many);
		expect(s.fields.edited).toHaveLength(50);
		expect((s.fields.edited as string[])[0]).toBe("f59.ts");
		const cleared = run([...many, { hook_event_name: "SessionStart", source: "clear" }]);
		expect(cleared.fields.edited).toBeUndefined();
	});
});

describe("snapshot", () => {
	it("always fits the budget, cutting back the oldest sessions first", () => {
		const big = "x".repeat(100_000);
		const sessions = Array.from({ length: 14 }, (_, i) => {
			const s = run([{ hook_event_name: "UserPromptSubmit", prompt: big }]);
			return { ...s, id: `s${i}`, updatedAt: i, state: i < 4 ? ("gone" as const) : s.state };
		});
		const snapshot = buildSnapshot({ id: "m", name: "Mac" }, sessions, 2, 0);
		expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(
			1_000_000,
		);
		const newest = snapshot.sessions[0];
		expect(newest?.id).toBe("s13");
		expect(newest?.fields.prompt).toBe(big);
		expect(newest?.fields.project).toBe("app");
	});

	it("drops closed sessions before open ones when even their states don't fit", () => {
		const sessions = Array.from({ length: 6000 }, (_, i) => ({
			id: `session-${String(i).padStart(120, "0")}`,
			state: i % 2 ? ("gone" as const) : ("working" as const),
			since: i,
			startedAt: i,
			updatedAt: i,
			fields: {},
		}));
		const snapshot = buildSnapshot({ id: "m", name: "Mac" }, sessions, 2, 0);
		expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(
			1_000_000,
		);
		expect(snapshot.sessions.some((s) => s.state === "working" && s.since === 0)).toBe(true);
	});

	it("hides fields above the exposure level", () => {
		const s = run([{ hook_event_name: "UserPromptSubmit", prompt: "secret plan" }]);
		const [level1] = buildSnapshot({ id: "m", name: "Mac" }, [s], 1, 0).sessions;
		const [level2] = buildSnapshot({ id: "m", name: "Mac" }, [s], 2, 0).sessions;
		expect(level1?.fields.prompt).toBeUndefined();
		expect(level1?.fields.project).toBe("app");
		expect(level2?.fields.prompt).toBe("secret plan");
	});

	it("shows commit counts at level 1 and commit messages and git activity from level 2", () => {
		const s = run([{ hook_event_name: "SessionStart", source: "startup" }]);
		s.fields.git = { commits: 1, earlier: 0 };
		s.fields.gitCommits = [
			{ sha: "abc1234", subject: "Add login", added: 1, removed: 0, files: 1 },
		];
		s.fields.gitActivity = [{ at: 1, kind: "commit", subject: "Add login" }];
		const [level1] = buildSnapshot({ id: "m", name: "Mac" }, [s], 1, 0).sessions;
		const [level2] = buildSnapshot({ id: "m", name: "Mac" }, [s], 2, 0).sessions;
		expect(level1?.fields.git).toEqual({ commits: 1, earlier: 0 });
		expect(level1?.fields.gitCommits).toBeUndefined();
		expect(level1?.fields.gitActivity).toBeUndefined();
		expect(level2?.fields.gitCommits).toHaveLength(1);
		expect(level2?.fields.gitActivity).toHaveLength(1);
	});
});
