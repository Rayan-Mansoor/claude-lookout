import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { sanitize, settleBackground, TEXT_MAX } from "@claude-lookout/protocol";
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
	/** Background tasks that reported back, by the tool use id that started them. */
	reported?: { toolUseIds: string[]; at: number };
	/** Background commands Claude stopped, which never report back, by the same id. */
	stopped?: { toolUseIds: string[]; at: number };
}

/** Which tool call started each background command, by the task id Claude stops it with. */
export type TaskStarts = Map<string, string>;

function addTask(
	list: { toolUseIds: string[]; at: number } | undefined,
	id: string,
	timestamp: unknown,
): { toolUseIds: string[]; at: number } {
	const at = Date.parse(String(timestamp));
	return { toolUseIds: [...(list?.toolUseIds ?? []), id], at: Number.isNaN(at) ? Date.now() : at };
}

/**
 * The tool use id a background task's report names, unless it reports it is still running.
 * Claude Code records a report as a user entry, or as an attachment when it arrives mid-turn.
 */
function reportedTask(entry: Record<string, unknown>): string | undefined {
	const attachment =
		entry.type === "attachment"
			? (entry.attachment as Record<string, unknown> | undefined)
			: undefined;
	const source = attachment ?? (entry.type === "user" ? entry : undefined);
	const origin = source?.origin as { kind?: unknown } | undefined;
	if (origin?.kind !== "task-notification") return undefined;
	const content = attachment
		? attachment.prompt
		: (entry.message as { content?: unknown } | undefined)?.content;
	const report = typeof content === "string" ? content : JSON.stringify(content ?? "");
	if (/<status>running<\/status>/.test(report)) return undefined;
	return /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(report)?.[1];
}

/** Note the task id of a background command that started, or return the one a stop ended. */
function stoppedTask(entry: Record<string, unknown>, starts: TaskStarts): string | undefined {
	const result = entry.toolUseResult as Record<string, unknown> | undefined;
	if (entry.type !== "user" || typeof result !== "object" || result === null) return undefined;
	if (typeof result.backgroundTaskId === "string") {
		const content = (entry.message as { content?: unknown } | undefined)?.content;
		const part = Array.isArray(content)
			? content.find((p) => p?.type === "tool_result" && typeof p.tool_use_id === "string")
			: undefined;
		if (part) starts.set(result.backgroundTaskId, part.tool_use_id);
		return undefined;
	}
	// A stopped subagent still reports back; a stopped command doesn't.
	if (
		typeof result.task_id === "string" &&
		typeof result.message === "string" &&
		result.message.startsWith("Successfully stopped task")
	) {
		return starts.get(result.task_id);
	}
	return undefined;
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

/**
 * Pull the news out of complete transcript lines, oldest first. Background commands started here
 * are added to `starts`, so a later read can tell which one a stop ended.
 */
export function scanTranscript(lines: string[], starts: TaskStarts = new Map()): TranscriptNews {
	const news: TranscriptNews = {};
	for (const line of lines) {
		// Most lines are tool results and request logs; skip them without parsing.
		if (
			line.startsWith('{"type":"api-request') ||
			(!line.includes('"type":"assistant"') &&
				!line.includes('"type":"user"') &&
				!line.includes('-title"') &&
				!line.includes("<task-notification>"))
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
		const reported = reportedTask(entry);
		if (reported) news.reported = addTask(news.reported, reported, entry.timestamp);
		const stopped = stoppedTask(entry, starts);
		if (stopped) news.stopped = addTask(news.stopped, stopped, entry.timestamp);
	}
	return news;
}

/** Follows transcripts as they grow, reading only what was appended since the last look. */
export class TranscriptReader {
	/** Where the next unread line starts, per transcript. */
	private readonly offsets = new Map<string, number>();
	/** A name you gave a conversation outranks every later one Claude Code writes. */
	private readonly customTitles = new Map<string, string>();
	private readonly starts = new Map<string, TaskStarts>();
	/** Reports that named no pending task yet, per transcript. */
	readonly held = new Map<string, HeldReport[]>();

	private startsOf(path: string): TaskStarts {
		const starts = this.starts.get(path) ?? new Map<string, string>();
		this.starts.set(path, starts);
		return starts;
	}

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
			return scanTranscript(
				buffer.subarray(0, end).toString("utf8").split("\n"),
				this.startsOf(path),
			);
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	/**
	 * Read a whole transcript for how its background tasks ended. The first read covers only the
	 * end of a transcript, so a report or stop further back would otherwise be missed for good.
	 */
	async readTasks(path: string): Promise<TranscriptNews> {
		const news: TranscriptNews = {};
		const starts = this.startsOf(path);
		let batch: string[] = [];
		const scan = () => {
			const found = scanTranscript(batch, starts);
			for (const key of ["reported", "stopped"] as const) {
				const list = found[key];
				if (!list) continue;
				news[key] = {
					toolUseIds: [...(news[key]?.toolUseIds ?? []), ...list.toolUseIds],
					at: list.at,
				};
			}
			batch = [];
		};
		try {
			const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
			for await (const line of lines) {
				batch.push(line);
				if (batch.length >= 1000) scan();
			}
		} catch {}
		scan();
		return news;
	}

	forget(path: string): void {
		this.offsets.delete(path);
		this.customTitles.delete(path);
		this.starts.delete(path);
		this.held.delete(path);
	}
}

/** How long a report that names no task yet is kept, waiting for that task's hook to arrive. */
const HELD_REPORT_MS = 10 * 60_000;

/** A task's report or stop, read before the hook that started the task was. */
export interface HeldReport {
	id: string;
	at: number;
	/** A report starts Claude again; a stop doesn't. */
	resumes: boolean;
	heldAt: number;
}

/**
 * Settle the session's background tasks that reported or were stopped. A report can be read
 * before the hook of the call that started its task arrives; it is kept for a while and settles
 * that task once it does. Returns the reports still kept.
 */
function settleTasks(
	agent: Agent,
	id: string,
	news: TranscriptNews,
	held: HeldReport[] = [],
	now = Date.now(),
): HeldReport[] {
	let session = agent.sessions.get(id);
	if (!session) return [];
	const before = session;
	const reports: HeldReport[] = [...held];
	for (const [list, resumes] of [
		[news.reported, true],
		[news.stopped, false],
	] as const) {
		for (const task of list?.toolUseIds ?? []) {
			reports.push({ id: task, at: list?.at ?? now, resumes, heldAt: now });
		}
	}
	const keep: HeldReport[] = [];
	for (const resumes of [true, false]) {
		const group = reports.filter((r) => r.resumes === resumes);
		const pending = new Set(session.background ?? []);
		const matched = group.filter((r) => pending.has(r.id));
		if (matched.length) {
			const at = Math.max(...matched.map((r) => r.at));
			session = settleBackground(
				session,
				matched.map((r) => r.id),
				at,
				resumes,
			);
		}
		keep.push(...group.filter((r) => !pending.has(r.id) && now - r.heldAt < HELD_REPORT_MS));
	}
	if (session !== before) agent.update(session);
	return keep;
}

/** Look through the whole transcript of each session still waiting on background tasks. */
export async function recoverTasks(agent: Agent, reader: TranscriptReader): Promise<void> {
	for (const session of [...agent.sessions.values()]) {
		if (!session.background?.length || !session.transcript || session.state === "gone") continue;
		settleTasks(agent, session.id, await reader.readTasks(session.transcript));
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
		const held = reader.held.get(session.transcript) ?? [];
		if (!news && held.length === 0) continue;
		const kept = settleTasks(agent, session.id, news ?? {}, held);
		if (kept.length) reader.held.set(session.transcript, kept);
		else reader.held.delete(session.transcript);
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
