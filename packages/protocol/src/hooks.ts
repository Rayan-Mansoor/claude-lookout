/**
 * The JSON Claude Code writes to a hook's stdin. Only the fields claude-lookout
 * reads are typed; everything else passes through untouched.
 * Reference: https://code.claude.com/docs/en/hooks
 */
export interface HookInput {
	hook_event_name: string;
	session_id: string;
	transcript_path?: string;
	cwd?: string;
	permission_mode?: string;
	effort?: { level?: string };
	agent_id?: string;
	agent_type?: string;
	[field: string]: unknown;
}

/** A hook input as the agent receives it, stamped by the hook process. */
export interface HookEvent {
	input: HookInput;
	/** PID of the Claude Code process that ran the hook. */
	pid?: number;
	/** Milliseconds since the epoch when the hook ran. */
	at: number;
}

/** The hook events claude-lookout subscribes to. */
export const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"Notification",
	"Elicitation",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"StopFailure",
	"SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export function isHookInput(value: unknown): value is HookInput {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.hook_event_name === "string" && typeof v.session_id === "string";
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
