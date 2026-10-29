import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { sanitize, TEXT_MAX } from "@claude-lookout/protocol";
import type { Agent } from "./agent.ts";

/** How much of a transcript is read the first time; they can grow past 100 MB. */
const FIRST_READ_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 120;

/** What a transcript says that hooks don't. */
export interface TranscriptNews {
	/** A name you gave the conversation with /rename. */
	customTitle?: string;
	/** The name Claude Code gave the conversation. */
	aiTitle?: string;
	/** Claude's newest text while working; `null` once you have sent a new prompt. */
	narration?: string | null;
}

function textOf(entry: Record<string, unknown>): string | undefined {
	const content = (entry.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
	return text || undefined;
}

/**
 * A prompt you typed, as opposed to a tool result or a message Claude Code adds by itself, such as
 * a background task reporting back, that it also records as a user entry.
 */
function isPrompt(entry: Record<string, unknown>): boolean {
	const origin = entry.origin as { kind?: unknown } | undefined;
	if (origin?.kind !== undefined && origin.kind !== "human") return false;
	const content = (entry.message as { content?: unknown } | undefined)?.content;
	return typeof content === "string" || (Array.isArray(content) && content[0]?.type === "text");
}

/** Pull the news out of complete transcript lines, oldest first. */
export function scanTranscript(lines: string[]): TranscriptNews {
	const news: TranscriptNews = {};
	for (const line of lines) {
		// Most lines are tool results and request logs; skip them without parsing.
		if (
			!line.includes('"type":"assistant"') &&
			!line.includes('"type":"user"') &&
			!line.includes('-title"')
		) {
			continue;
		}
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
			news.customTitle = entry.customTitle;
		} else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
			news.aiTitle = entry.aiTitle;
		}
		if (entry.isSidechain === true || entry.isMeta === true) continue;
		if (entry.type === "assistant") {
			const text = textOf(entry);
			if (text) news.narration = text;
		} else if (entry.type === "user" && isPrompt(entry)) {
			news.narration = null;
		}
	}
	return news;
}

/** Follows transcripts as they grow, reading only what was appended since the last look. */
export class TranscriptReader {
	/** Where the next unread line starts, per transcript. */
	private readonly offsets = new Map<string, number>();
	/** A name you gave a conversation outranks every later one Claude Code writes. */
	private readonly customTitles = new Map<string, string>();

	/** The conversation's name as of the last read. */
	title(path: string, news: TranscriptNews): string | undefined {
		if (news.customTitle) this.customTitles.set(path, news.customTitle);
		return this.customTitles.get(path) ?? news.aiTitle;
	}

	read(path: string): TranscriptNews | undefined {
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const size = fstatSync(fd).size;
			let offset = this.offsets.get(path);
			if (offset === undefined || size < offset) offset = Math.max(0, size - FIRST_READ_BYTES);
			if (size === offset) return undefined;
			const buffer = Buffer.alloc(size - offset);
			readSync(fd, buffer, 0, buffer.length, offset);
			// Stop at the last complete line; the rest is read once Claude Code finishes writing it.
			const end = buffer.lastIndexOf(0x0a) + 1;
			this.offsets.set(path, offset + end);
			if (end === 0) return undefined;
			return scanTranscript(buffer.subarray(0, end).toString("utf8").split("\n"));
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	forget(path: string): void {
		this.offsets.delete(path);
		this.customTitles.delete(path);
	}
}

/** Bring what each open session's transcript says onto the session. */
export function followTranscripts(agent: Agent, reader: TranscriptReader): void {
	for (const session of [...agent.sessions.values()]) {
		if (!session.transcript) continue;
		if (session.state === "gone") {
			reader.forget(session.transcript);
			continue;
		}
		const news = reader.read(session.transcript);
		if (!news) continue;
		const fields: Record<string, unknown> = {};
		if (news.narration !== undefined) {
			fields.narration = news.narration === null ? null : sanitize(news.narration, TEXT_MAX);
		}
		const title = reader.title(session.transcript, news);
		if (title) fields.title = sanitize(title, TITLE_MAX);
		agent.setFields(session.id, fields);
	}
}
