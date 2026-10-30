import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@claude-lookout/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { defaultConfig } from "./config.ts";
import { followTranscripts, scanTranscript, TranscriptReader } from "./transcript.ts";

const assistant = (text: string, extra: object = {}) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
		...extra,
	});
const toolUse = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
});
const toolResult = JSON.stringify({
	type: "user",
	message: { content: [{ type: "tool_result", content: "ok" }] },
});
const prompt = (text: string) => JSON.stringify({ type: "user", message: { content: text } });

describe("scanTranscript", () => {
	it("keeps Claude's newest text, past tool calls and their results", () => {
		const news = scanTranscript([
			assistant("Looking at the failing test"),
			toolUse,
			toolResult,
			assistant("Found it, fixing the date parser", { isSidechain: false }),
			toolUse,
			toolResult,
		]);
		expect(news.narration).toBe("Found it, fixing the date parser");
	});

	it("ignores subagents and clears once you send a prompt", () => {
		expect(
			scanTranscript([assistant("Searching", { isSidechain: true })]).narration,
		).toBeUndefined();
		expect(scanTranscript([assistant("Done"), prompt("Now the docs")]).narration).toBeNull();
	});

	it("keeps it when Claude Code adds a message by itself", () => {
		const report = JSON.stringify({
			type: "user",
			origin: { kind: "task-notification" },
			message: { content: "<task-notification>…</task-notification>" },
		});
		const typed = JSON.stringify({
			type: "user",
			origin: { kind: "human" },
			message: { content: "Now the docs" },
		});
		expect(scanTranscript([assistant("Waiting on the tests"), report]).narration).toBe(
			"Waiting on the tests",
		);
		expect(scanTranscript([assistant("Done"), typed]).narration).toBeNull();
	});
});

describe("background task reports", () => {
	const report = (toolUseId: string, status: string) =>
		JSON.stringify({
			type: "user",
			origin: { kind: "task-notification" },
			timestamp: "2026-10-30T10:00:00.000Z",
			message: {
				content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
			},
		});

	it("names the tool calls whose tasks ended, with when they reported", () => {
		const news = scanTranscript([report("toolu_1", "completed"), report("toolu_2", "failed")]);
		expect(news.reported).toEqual({
			toolUseIds: ["toolu_1", "toolu_2"],
			at: Date.parse("2026-10-30T10:00:00.000Z"),
		});
	});

	it("reads a report that arrived mid-turn, which Claude Code records as an attachment", () => {
		const content =
			"<task-notification>\n<task-id>b2</task-id>\n<tool-use-id>toolu_3</tool-use-id>\n<status>failed</status>\n</task-notification>";
		const absorbed = [
			JSON.stringify({ type: "queue-operation", operation: "enqueue", content }),
			JSON.stringify({
				type: "attachment",
				isSidechain: false,
				timestamp: "2026-10-30T18:36:15.328Z",
				attachment: {
					type: "queued_command",
					prompt: content,
					commandMode: "task-notification",
					origin: { kind: "task-notification", producer: "session-task" },
				},
			}),
		];
		expect(scanTranscript(absorbed).reported).toEqual({
			toolUseIds: ["toolu_3"],
			at: Date.parse("2026-10-30T18:36:15.328Z"),
		});
	});

	it("skips tasks still running and text that only mentions a report", () => {
		expect(scanTranscript([report("toolu_1", "running")]).reported).toBeUndefined();
		expect(
			scanTranscript([prompt("<task-notification><tool-use-id>x</tool-use-id>")]).reported,
		).toBeUndefined();
		const pasted = JSON.stringify({
			type: "attachment",
			attachment: { type: "file", content: "<task-notification><tool-use-id>y</tool-use-id>" },
		});
		expect(scanTranscript([pasted]).reported).toBeUndefined();
	});
});

describe("background commands Claude stopped", () => {
	const startedCommand = JSON.stringify({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "running" }] },
		toolUseResult: { stdout: "", backgroundTaskId: "bk1" },
	});
	const stopResult = (message: string, taskId = "bk1") =>
		JSON.stringify({
			type: "user",
			timestamp: "2026-10-30T18:21:58.353Z",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_10", content: message }] },
			toolUseResult: { message, task_id: taskId, task_type: "local_bash" },
		});

	it("names the command a stop ended, even when it started in an earlier read", () => {
		const starts = new Map<string, string>();
		expect(scanTranscript([startedCommand], starts).stopped).toBeUndefined();
		expect(
			scanTranscript([stopResult("Successfully stopped task: bk1 (npm test)")], starts),
		).toEqual({ stopped: { toolUseIds: ["toolu_9"], at: Date.parse("2026-10-30T18:21:58.353Z") } });
	});

	it("skips stops that failed and tasks it never saw start", () => {
		expect(
			scanTranscript([startedCommand, stopResult("No task found with ID: bk1")]).stopped,
		).toBeUndefined();
		expect(
			scanTranscript([startedCommand, stopResult("Successfully stopped task: a1", "a1")]).stopped,
		).toBeUndefined();
	});
});

describe("TranscriptReader", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reads only what was appended, waiting for lines to be complete", () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-transcript-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, `${assistant("First")}\n`);
		const reader = new TranscriptReader();
		expect(reader.read(file)?.narration).toBe("First");
		expect(reader.read(file)).toBeUndefined();

		const line = assistant("Second, with ünïcödé");
		appendFileSync(file, line.slice(0, 30));
		expect(reader.read(file)).toBeUndefined();
		appendFileSync(file, `${line.slice(30)}\n`);
		expect(reader.read(file)?.narration).toBe("Second, with ünïcödé");
	});

	it("finds how background tasks ended anywhere in a transcript, past what the first read covers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-transcript-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		const report = JSON.stringify({
			type: "user",
			origin: { kind: "task-notification" },
			timestamp: "2026-10-30T10:00:00.000Z",
			message: {
				content: "<task-notification><tool-use-id>toolu_1</tool-use-id></task-notification>",
			},
		});
		const started = JSON.stringify({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "running" }] },
			toolUseResult: { backgroundTaskId: "bk2" },
		});
		const stopped = JSON.stringify({
			type: "user",
			timestamp: "2026-10-30T11:00:00.000Z",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "ok" }] },
			toolUseResult: { message: "Successfully stopped task: bk2", task_id: "bk2" },
		});
		const filler = `${toolResult}\n`.repeat(Math.ceil((3 * 1024 * 1024) / toolResult.length));
		writeFileSync(file, `${report}\n${started}\n${filler}${stopped}\n`);

		const reader = new TranscriptReader();
		expect(reader.read(file)?.reported).toBeUndefined();
		expect(await reader.readTasks(file)).toEqual({
			reported: { toolUseIds: ["toolu_1"], at: Date.parse("2026-10-30T10:00:00.000Z") },
			stopped: { toolUseIds: ["toolu_2"], at: Date.parse("2026-10-30T11:00:00.000Z") },
		});
	});
});

describe("conversation title", () => {
	const aiTitle = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t });
	const customTitle = (t: string) => JSON.stringify({ type: "custom-title", customTitle: t });

	it("uses Claude Code's latest name until you give one with /rename", () => {
		const reader = new TranscriptReader();
		const first = scanTranscript([aiTitle("Fix login"), aiTitle("Fix login redirect")]);
		expect(reader.title("t.jsonl", first)).toBe("Fix login redirect");
		expect(reader.title("t.jsonl", scanTranscript([customTitle("Auth work")]))).toBe("Auth work");
		expect(reader.title("t.jsonl", scanTranscript([aiTitle("Something else")]))).toBe("Auth work");
	});
});

describe("following transcripts", () => {
	it("settles a task whose report was read before the hook that started it", () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-transcript-"));
		const file = join(dir, "session.jsonl");
		const agent = new Agent(
			{ ...defaultConfig(), machine: { id: "m", name: "Studio" } },
			{ gitBranch: () => undefined },
		);
		const send = (input: Partial<HookInput>, at: number) =>
			agent.handle({
				input: { session_id: "s1", transcript_path: file, ...input } as HookInput,
				at,
			});
		const report = JSON.stringify({
			type: "user",
			origin: { kind: "task-notification" },
			timestamp: new Date(1000).toISOString(),
			message: {
				content: "<task-notification><tool-use-id>toolu_9</tool-use-id></task-notification>",
			},
		});
		send({ hook_event_name: "UserPromptSubmit", prompt: "build it" }, 500);
		writeFileSync(file, `${report}\n`);
		const reader = new TranscriptReader();
		followTranscripts(agent, reader);

		// The hook of the call that started the task comes in only now.
		send(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "toolu_9",
				tool_input: { command: "npm run build", run_in_background: true },
			},
			900,
		);
		send({ hook_event_name: "Stop" }, 2000);
		expect(agent.sessions.get("s1")?.state).toBe("background");
		followTranscripts(agent, reader);
		expect(agent.sessions.get("s1")?.state).toBe("finished");
		rmSync(dir, { recursive: true, force: true });
	});
});
