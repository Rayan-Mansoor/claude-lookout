import { applyFields, type FieldContext } from "./fields.ts";
import { type HookEvent, type HookInput, record, str } from "./hooks.ts";

/**
 * Where a session stands, from the viewer's point of view.
 * - ready: open, nothing asked yet
 * - working: Claude is running
 * - permission / question / plan: blocked until you respond
 * - background: the run ended, but Claude carries on by itself once its background tasks report
 * - finished: the run ended and Claude waits for your next prompt
 * - interrupted: the run was stopped before it finished
 * - gone: the session closed
 */
export type SessionState =
	| "ready"
	| "working"
	| "permission"
	| "question"
	| "plan"
	| "background"
	| "finished"
	| "interrupted"
	| "gone";

export const BLOCKED_STATES: readonly SessionState[] = ["permission", "question", "plan"];

export interface Session {
	id: string;
	state: SessionState;
	/** When the session entered its current state. */
	since: number;
	startedAt: number;
	updatedAt: number;
	/** PID of the Claude Code process, when known. */
	pid?: number;
	/** The conversation transcript Claude Code writes; read locally, never sent. */
	transcript?: string;
	/** When Claude's shell commands ran, so git work can be credited to the session; never sent. */
	shell?: ShellRun[];
	/** Tool calls Claude left running in the background, by tool use id; never sent. */
	background?: string[];
	/** Requests waiting on you, oldest first; never sent. */
	blocks?: Block[];
	fields: Record<string, unknown>;
}

/**
 * One request waiting on you: a permission prompt, a question or a plan. `tool` and `input` tell
 * which call it holds up, so that call finishing ends it while other calls finishing don't. A
 * request known only from a notification has neither, and any call that moves on ends it.
 */
export interface Block {
	/** The subagent that asked, or "main". */
	agent: string;
	tool?: string;
	input?: string;
	state: SessionState;
	at: number;
}

/** One shell command Claude ran: from just before it started until it returned. */
export interface ShellRun {
	id?: string;
	start: number;
	/** Missing while it runs. */
	end?: number;
}

/** Shell commands remembered per session; older ones fall out of git credit. */
const SHELL_RUNS_MAX = 300;

/** Note when a shell command starts and ends. */
function trackShell(session: Session, input: HookInput, at: number): void {
	const e = input.hook_event_name;
	const id = str(input.tool_use_id);
	if (input.tool_name === "Bash" && e === "PreToolUse") {
		const runs = [...(session.shell ?? []), id ? { id, start: at } : { start: at }];
		session.shell = runs.slice(-SHELL_RUNS_MAX);
		return;
	}
	if (!session.shell) return;
	const ends =
		input.tool_name === "Bash" &&
		(e === "PostToolUse" || e === "PostToolUseFailure" || e === "PermissionDenied");
	// A run that stops or a new prompt means nothing is still running.
	const endsAll =
		e === "Stop" || e === "StopFailure" || e === "SessionEnd" || e === "UserPromptSubmit";
	if (!ends && !endsAll) return;
	session.shell = session.shell.map((run) =>
		run.end === undefined && (endsAll || (id !== undefined && run.id === id))
			? { ...run, end: at }
			: run,
	);
}

/** Tools that put Claude in a blocked state when called. */
const BLOCKING_TOOLS: Record<string, SessionState> = {
	AskUserQuestion: "question",
	ExitPlanMode: "plan",
};

/** Tools that always run in the background and report back when they end. */
const BACKGROUND_TOOLS = new Set(["Monitor", "Workflow"]);

/** The tool use id of a call that kept running after it returned, if this event is one. */
function startedInBackground(input: HookInput): string | undefined {
	// A subagent's background tasks report to the subagent, not to the session.
	if (input.hook_event_name !== "PostToolUse" || input.agent_id !== undefined) return undefined;
	const tool = str(input.tool_name);
	const inBackground =
		(tool !== undefined && BACKGROUND_TOOLS.has(tool)) ||
		record(input.tool_input).run_in_background === true;
	return inBackground ? str(input.tool_use_id) : undefined;
}

/** The state a hook event moves a session into, or undefined to keep the current one. */
export function nextState(input: HookInput, current: SessionState): SessionState | undefined {
	const tool = str(input.tool_name);
	switch (input.hook_event_name) {
		case "SessionStart":
			return current === "gone" || input.source === "startup" || input.source === "clear"
				? "ready"
				: undefined;
		case "UserPromptSubmit":
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PermissionDenied":
			return "working";
		case "PreToolUse":
			return (tool ? BLOCKING_TOOLS[tool] : undefined) ?? "working";
		case "PermissionRequest":
			return (tool ? BLOCKING_TOOLS[tool] : undefined) ?? "permission";
		case "Notification":
			if (input.notification_type === "permission_prompt" && !BLOCKED_STATES.includes(current)) {
				return "permission";
			}
			return input.notification_type === "elicitation_dialog" ? "question" : undefined;
		case "Elicitation":
			return "question";
		case "Stop":
		case "StopFailure":
			return "finished";
		case "SessionEnd":
			return "gone";
		default:
			return undefined;
	}
}

const MAIN_AGENT = "main";

function agentOf(input: HookInput): string {
	return str(input.agent_id) ?? MAIN_AGENT;
}

function inputKey(input: HookInput): string {
	return JSON.stringify(input.tool_input ?? null);
}

/**
 * Keep the list of requests waiting on you in step with one event. Returns true when the event
 * ended the last of them, so Claude is running again.
 */
function trackBlocks(session: Session, input: HookInput, at: number): boolean {
	const before = session.blocks ?? [];
	const tool = str(input.tool_name);
	const agent = agentOf(input);
	let blocks = before;
	const open = (state: SessionState) => {
		const block: Block = { agent, state, at };
		if (tool) {
			block.tool = tool;
			block.input = inputKey(input);
		}
		const same = (b: Block) => b.agent === agent && b.tool === tool && b.input === block.input;
		blocks = [...blocks.filter((b) => !same(b)), block];
	};
	const keyed = (b: Block) => b.tool !== undefined;
	switch (input.hook_event_name) {
		case "PermissionRequest":
			open((tool ? BLOCKING_TOOLS[tool] : undefined) ?? "permission");
			break;
		case "PreToolUse":
			if (tool && BLOCKING_TOOLS[tool]) open(BLOCKING_TOOLS[tool]);
			// A new call from the same agent means its earlier requests were answered.
			else blocks = blocks.filter((b) => keyed(b) && (b.agent !== agent || b.at >= at));
			break;
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PermissionDenied": {
			const key = inputKey(input);
			const mine = (b: Block) => b.agent === agent && b.tool === tool;
			const done = blocks.find((b) => mine(b) && b.input === key) ?? blocks.find((b) => mine(b));
			blocks = blocks.filter((b) => b !== done && keyed(b));
			break;
		}
		case "Notification":
			// Hooks normally report the request itself first; a notification alone still counts.
			if (input.notification_type === "permission_prompt" && blocks.length === 0) {
				blocks = [{ agent: MAIN_AGENT, state: "permission", at }];
			} else if (input.notification_type === "elicitation_dialog") {
				blocks = [...blocks, { agent: MAIN_AGENT, state: "question", at }];
			}
			break;
		case "Elicitation":
			blocks = [...blocks, { agent: MAIN_AGENT, state: "question", at }];
			break;
		case "SubagentStop":
			blocks = blocks.filter((b) => b.agent !== agent);
			break;
		case "UserPromptSubmit":
		case "Stop":
		case "StopFailure":
		case "SessionEnd":
		case "SessionStart":
			blocks = [];
			break;
	}
	if (blocks.length) session.blocks = blocks;
	else delete session.blocks;
	return before.length > 0 && blocks.length === 0;
}

/** Apply one hook event to a session, creating the session on its first event. */
export function reduce(prev: Session | undefined, event: HookEvent, ctx: FieldContext): Session {
	const { input, at } = event;
	const session: Session = prev
		? { ...prev, fields: { ...prev.fields } }
		: { id: input.session_id, state: "ready", since: at, startedAt: at, updatedAt: at, fields: {} };

	const started = startedInBackground(input);
	if (started && !session.background?.includes(started)) {
		session.background = [...(session.background ?? []), started];
	}
	if (
		input.hook_event_name === "SessionStart" &&
		(input.source === "startup" || input.source === "clear")
	) {
		delete session.background;
	}

	// Hooks run as separate processes, so one can arrive after a later one: an event from before
	// the current state began updates details but never the state.
	const late = prev !== undefined && at < session.since;
	let state: SessionState | undefined;
	if (!late) {
		state = nextState(input, session.state);
		// Subagent requests count too: a subagent waiting on a permission blocks the session.
		const released = trackBlocks(session, input, at);
		const newest = session.blocks?.at(-1);
		if (newest) state = newest.state;
		else if (released && (!state || BLOCKED_STATES.includes(state))) {
			state = input.hook_event_name === "SessionStart" ? "ready" : "working";
		}
	}
	if (state === "finished" && session.background?.length) state = "background";
	if (state && state !== session.state) {
		session.state = state;
		session.since = at;
	}
	trackShell(session, input, at);
	if (event.pid !== undefined) session.pid = event.pid;
	if (typeof input.transcript_path === "string") session.transcript = input.transcript_path;
	session.updatedAt = at;
	applyFields(session.fields, input, ctx, at);
	return session;
}

/**
 * Mark background tasks as reported. Once the last one reports, Claude Code starts Claude again by
 * itself, so a session waiting on them is working again; unless it already stopped after the last
 * report, which happens when the report is read only after Claude's follow-up run ended.
 * Claude stopping a task ends it without starting Claude again, so `resumes` is false then.
 */
export function settleBackground(
	session: Session,
	toolUseIds: string[],
	at: number,
	resumes = true,
): Session {
	if (!session.background) return session;
	const pending = session.background.filter((id) => !toolUseIds.includes(id));
	if (pending.length === session.background.length) return session;
	const { background: _, ...settled } = session;
	if (pending.length) return { ...settled, background: pending };
	if (session.state !== "background") return settled;
	return resumes && at >= session.since
		? { ...settled, state: "working", since: at, updatedAt: at }
		: { ...settled, state: "finished", updatedAt: Math.max(session.updatedAt, at) };
}

/** What each state is called wherever a person reads it. */
export const STATE_LABELS: Record<SessionState, string> = {
	ready: "Ready",
	working: "Working",
	permission: "Needs permission",
	question: "Asking you",
	plan: "Plan to approve",
	background: "Running in background",
	finished: "Finished",
	interrupted: "Interrupted",
	gone: "Closed",
};

/** "45s", "12m", "3h 5m", "2d" */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
