import { applyFields, type FieldContext } from "./fields.ts";
import { type HookEvent, type HookInput, str } from "./hooks.ts";

/**
 * Where a session stands, from the viewer's point of view.
 * - ready: open, nothing asked yet
 * - working: Claude is running
 * - permission / question / plan: blocked until you respond
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

/** Tools that put Claude in a blocked state when called. */
const BLOCKING_TOOLS: Record<string, SessionState> = {
	AskUserQuestion: "question",
	ExitPlanMode: "plan",
};

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
	if (state && state !== session.state) {
		session.state = state;
		session.since = at;
	}
	if (event.pid !== undefined) session.pid = event.pid;
	session.updatedAt = at;
	applyFields(session.fields, input, ctx);
	return session;
}

/** What each state is called wherever a person reads it. */
export const STATE_LABELS: Record<SessionState, string> = {
	ready: "Ready",
	working: "Working",
	permission: "Needs permission",
	question: "Asking you",
	plan: "Plan to approve",
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
