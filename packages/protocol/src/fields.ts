import { type HookInput, record, str } from "./hooks.ts";
import { sanitize } from "./redact.ts";
import { describeTool, type ToolCall } from "./tools.ts";

/**
 * How much a field reveals. The session state itself is level 0 and always shown.
 * 1 context: where and how the session runs, and what it is doing right now
 * 2 content: your prompts, Claude's questions, permission requests, plans and replies
 * 3 live feed: a rolling view of the conversation (off by default)
 */
export type Level = 1 | 2 | 3;

export const DEFAULT_LEVEL: Level = 2;

export interface FieldContext {
	gitBranch(cwd: string): string | undefined;
}

/**
 * One piece of information shown about a session.
 * `extract` returns the new value, `undefined` to keep the current value, or `null` to clear it.
 */
export interface FieldDef<T = unknown> {
	key: string;
	label: string;
	level: Level;
	extract(input: HookInput, current: T | undefined, ctx: FieldContext): T | null | undefined;
}

/** One choice Claude offers, with what it means and, for a visual comparison, a mockup or snippet. */
export interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface Question {
	question: string;
	header?: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

/** One option as Claude offered it, redacted and clipped. */
function questionOption(raw: unknown): QuestionOption {
	const o = record(raw);
	const description = str(o.description);
	const preview = str(o.preview);
	return {
		label: sanitize(str(o.label) ?? "", 200),
		...(description ? { description: sanitize(description, 1000) } : {}),
		...(preview ? { preview: sanitize(preview, 20_000) } : {}),
	};
}

export interface PermissionRequest extends ToolCall {
	/** The full command or input, redacted and clipped. */
	detail?: string;
	suggestions: string[];
}

export interface Subagent {
	id: string;
	type: string;
}

export interface TaskProgress {
	total: number;
	done: number;
	current?: string;
}

/** Long enough for the longest reply Claude Code writes by default, so nothing is cut short. */
const TEXT_MAX = 128_000;

const RUN_START = new Set(["UserPromptSubmit"]);
const RUN_END = new Set(["Stop", "StopFailure", "SessionEnd"]);

/** Clear a blocked-state field once Claude moves past it. */
function clearedAfterBlock(input: HookInput): null | undefined {
	const e = input.hook_event_name;
	return e === "PostToolUse" ||
		e === "PostToolUseFailure" ||
		e === "PermissionDenied" ||
		RUN_START.has(e) ||
		RUN_END.has(e)
		? null
		: undefined;
}

function toolInput(input: HookInput, tool: string): Record<string, unknown> | undefined {
	return input.tool_name === tool ? record(input.tool_input) : undefined;
}

const project: FieldDef<string> = {
	key: "project",
	label: "Project",
	level: 1,
	extract: (input) => {
		const cwd = str(input.cwd);
		return cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : undefined;
	},
};

const cwd: FieldDef<string> = {
	key: "cwd",
	label: "Folder",
	level: 1,
	extract: (input) => str(input.cwd),
};

const branch: FieldDef<string> = {
	key: "branch",
	label: "Git branch",
	level: 1,
	extract: (input, current, ctx) => {
		const dir = str(input.cwd);
		if (!dir) return undefined;
		return ctx.gitBranch(dir) ?? (current === undefined ? undefined : null);
	},
};

const model: FieldDef<string> = {
	key: "model",
	label: "Model",
	level: 1,
	extract: (input) => str(input.model),
};

const mode: FieldDef<string> = {
	key: "mode",
	label: "Permission mode",
	level: 1,
	extract: (input) => str(input.permission_mode),
};

const effort: FieldDef<string> = {
	key: "effort",
	label: "Effort",
	level: 1,
	extract: (input) => str(input.effort?.level),
};

const startedFrom: FieldDef<string> = {
	key: "startedFrom",
	label: "Started from",
	level: 1,
	extract: (input) => (input.hook_event_name === "SessionStart" ? str(input.source) : undefined),
};

const activity: FieldDef<ToolCall> = {
	key: "activity",
	label: "Doing now",
	level: 1,
	extract: (input) => {
		const tool = str(input.tool_name);
		if (input.hook_event_name === "PreToolUse" && tool) {
			return describeTool(tool, input.tool_input, str(input.cwd));
		}
		return RUN_START.has(input.hook_event_name) || RUN_END.has(input.hook_event_name)
			? null
			: undefined;
	},
};

const subagents: FieldDef<Subagent[]> = {
	key: "subagents",
	label: "Subagents",
	level: 1,
	extract: (input, current = []) => {
		const id = str(input.agent_id);
		if (input.hook_event_name === "SubagentStart" && id) {
			return [...current, { id, type: str(input.agent_type) ?? "agent" }];
		}
		if (input.hook_event_name === "SubagentStop" && id) {
			const rest = current.filter((a) => a.id !== id);
			return rest.length > 0 ? rest : null;
		}
		return input.hook_event_name === "SessionEnd" ? null : undefined;
	},
};

const tasks: FieldDef<TaskProgress> = {
	key: "tasks",
	label: "Tasks",
	level: 1,
	extract: (input) => {
		const args = toolInput(input, "TodoWrite");
		if (!args || input.hook_event_name !== "PreToolUse" || !Array.isArray(args.todos)) {
			return undefined;
		}
		const todos = args.todos.map(record);
		if (todos.length === 0) return null;
		const active = todos.find((t) => t.status === "in_progress");
		const current = str(active?.activeForm) ?? str(active?.content);
		return {
			total: todos.length,
			done: todos.filter((t) => t.status === "completed").length,
			...(current ? { current: sanitize(current, 160) } : {}),
		};
	},
};

const prompt: FieldDef<string> = {
	key: "prompt",
	label: "Your last prompt",
	level: 2,
	extract: (input) => {
		const text = input.hook_event_name === "UserPromptSubmit" ? str(input.prompt) : undefined;
		return text ? sanitize(text, TEXT_MAX) : undefined;
	},
};

const permission: FieldDef<PermissionRequest> = {
	key: "permission",
	label: "Permission requested",
	level: 2,
	extract: (input) => {
		const tool = str(input.tool_name);
		if (input.hook_event_name === "PermissionRequest" && tool) {
			const args = record(input.tool_input);
			const detail = str(args.command) ?? str(args.content) ?? str(args.new_string);
			const suggestions = Array.isArray(input.permission_suggestions)
				? input.permission_suggestions.flatMap((s) =>
						Array.isArray(record(s).rules)
							? (record(s).rules as unknown[]).map((r) => {
									const rule = record(r);
									const content = str(rule.ruleContent);
									return `${str(rule.toolName) ?? tool}${content ? `(${content})` : ""}`;
								})
							: [],
					)
				: [];
			return {
				...describeTool(tool, input.tool_input, str(input.cwd)),
				...(detail ? { detail: sanitize(detail, TEXT_MAX) } : {}),
				suggestions: suggestions.map((s) => sanitize(s, 200)),
			};
		}
		return input.hook_event_name === "PreToolUse" ? null : clearedAfterBlock(input);
	},
};

const questions: FieldDef<Question[]> = {
	key: "questions",
	label: "Claude is asking",
	level: 2,
	extract: (input) => {
		const args = toolInput(input, "AskUserQuestion");
		if (input.hook_event_name === "PreToolUse" && args && Array.isArray(args.questions)) {
			return args.questions.map((raw) => {
				const q = record(raw);
				const header = str(q.header);
				return {
					question: sanitize(str(q.question) ?? "", 1000),
					...(header ? { header: sanitize(header, 60) } : {}),
					options: Array.isArray(q.options) ? q.options.map(questionOption) : [],
					multiSelect: q.multiSelect === true,
				};
			});
		}
		return clearedAfterBlock(input);
	},
};

const plan: FieldDef<string> = {
	key: "plan",
	label: "Plan to approve",
	level: 2,
	extract: (input) => {
		const args = toolInput(input, "ExitPlanMode");
		const text = input.hook_event_name === "PreToolUse" ? str(args?.plan) : undefined;
		return text ? sanitize(text, TEXT_MAX) : clearedAfterBlock(input);
	},
};

const lastMessage: FieldDef<string> = {
	key: "lastMessage",
	label: "Claude's last message",
	level: 2,
	extract: (input) => {
		const text =
			input.hook_event_name === "Stop" && input.agent_id === undefined
				? str(input.last_assistant_message)
				: undefined;
		if (text) return sanitize(text, TEXT_MAX);
		return RUN_START.has(input.hook_event_name) ? null : undefined;
	},
};

const error: FieldDef<string> = {
	key: "error",
	label: "Run failed",
	level: 1,
	extract: (input) => {
		if (input.hook_event_name === "StopFailure") {
			return sanitize(str(input.error) ?? str(input.reason) ?? "The run ended with an error", 300);
		}
		return RUN_START.has(input.hook_event_name) ? null : undefined;
	},
};

/** Every field claude-lookout knows about, in display order. Add new fields here. */
export const FIELDS: readonly FieldDef[] = [
	project,
	cwd,
	branch,
	model,
	mode,
	effort,
	startedFrom,
	activity,
	subagents,
	tasks,
	error,
	prompt,
	permission,
	questions,
	plan,
	lastMessage,
] as FieldDef[];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function fieldLevel(key: string): Level | undefined {
	return BY_KEY.get(key)?.level;
}

/** Run every field's extractor against one hook input, updating `fields` in place. */
export function applyFields(
	fields: Record<string, unknown>,
	input: HookInput,
	ctx: FieldContext,
): void {
	for (const def of FIELDS) {
		const value = def.extract(input, fields[def.key], ctx);
		if (value === null) delete fields[def.key];
		else if (value !== undefined) fields[def.key] = value;
	}
}

/** Keep only fields at or below `maxLevel`; unknown keys are dropped. */
export function visibleFields(
	fields: Record<string, unknown>,
	maxLevel: Level,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		const level = fieldLevel(key);
		if (level !== undefined && level <= maxLevel) out[key] = value;
	}
	return out;
}
