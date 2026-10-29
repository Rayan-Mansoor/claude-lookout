import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanTranscript, TranscriptReader } from "./transcript.ts";

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
