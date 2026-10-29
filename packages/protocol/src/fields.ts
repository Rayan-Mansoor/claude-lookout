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
 * A field without `extract` is filled in by the agent from outside the hooks, such as git.
 */
export interface FieldDef<T = unknown> {
	key: string;
	label: string;
	level: Level;
	extract?(
		input: HookInput,
		current: T | undefined,
		ctx: FieldContext,
		/** When the hook ran, in milliseconds since the epoch. */
		at: number,
	): T | null | undefined;
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

export interface FileChange {
	/** Relative to the repository root. */
	path: string;
	added: number;
	removed: number;
	/** `conflict` while a merge, rebase or cherry-pick waits for the file to be resolved. */
	status: "new" | "changed" | "deleted" | "conflict";
}

/** What is changed in the working tree and not yet committed. */
export interface WorkingChanges {
	/** The most changed files first, at most `FILE_CHANGES_MAX`. */
	files: FileChange[];
	/** How many files are changed in all. */
	total: number;
	added: number;
	removed: number;
}

/** Where a session's repository stands: what it committed, and against its upstream. */
export interface GitSummary {
	/** Commits the session made that are still on a branch. */
	commits: number;
	/** Commits from before the session that it rewrote (amended, folded into, rebased). */
	earlier: number;
	/** Of those, how many no remote has yet; missing when the repository has no remote. */
	unpushed?: number;
	/** The branch the checked-out branch tracks. */
	upstream?: { ref: string; ahead: number; behind: number };
	/** A git operation stopped half-way, such as a rebase waiting on a conflict. */
	busy?: {
		kind: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";
		step?: number;
		total?: number;
	};
}

/** A commit the session made or rewrote, as it is now. */
export interface GitCommit {
	/** Short hash. */
	sha: string;
	subject: string;
	added: number;
	removed: number;
	files: number;
	/** Made before the session, then rewritten by it. */
	earlier?: true;
	/** No remote has it yet. */
	unpushed?: true;
}

/** One thing that happened in git while the session was open. */
export interface GitEvent {
	at: number;
	kind:
		| "commit"
		| "amend"
		| "rebase"
		| "reset"
		| "merge"
		| "pull"
		| "fetch"
		| "push"
		| "switch"
		| "cherry-pick"
		| "revert"
		| "branch-created"
		| "branch-deleted"
		| "tag-created"
		| "tag-deleted"
		| "stash"
		| "unstash"
		| "other";
	/** Missing when Claude did it in this session; otherwise another session, or you outside Claude. */
	by?: "other" | "you";
	/** The commit subject, or for `other` what git recorded. */
	subject?: string;
	/** Short hash of the commit made. */
	sha?: string;
	/** The branch, tag or remote branch acted on; for `switch` the one moved to. */
	ref?: string;
	/** For `switch`, the branch left. */
	from?: string;
	/** Commits pulled, fetched, pushed, merged, rebased, or for `reset` dropped. */
	count?: number;
	/** For `reset`, the subjects of the dropped commits, newest first. */
	dropped?: string[];
	/** For `rebase`, the subjects of the commits that fixups and squashes were folded into. */
	folded?: string[];
	/** For `rebase`, commits whose message changed, and commits removed outright. */
	reworded?: number;
	removed?: number;
	/** For `pull`, local commits replayed on top of what was pulled. */
	replayed?: number;
	/** The action rewrote a commit made before the session. */
	earlier?: true;
	/** A push that replaced commits on the remote. */
	forced?: true;
	/** A merge or pull that only moved the branch forward. */
	fastForward?: true;
	/** A rebase that was given up, or one still running. */
	aborted?: true;
	running?: true;
}

/** One tool call in a session's recent history. */
export interface Step extends ToolCall {
	/** When the call started. */
	at: number;
	/** How it ended; missing while it runs or when the run stopped first. */
	outcome?: "done" | "failed" | "denied";
	id?: string;
}

const STEPS_MAX = 15;

export const FILE_CHANGES_MAX = 100;
const EDITED_MAX = 50;
const EDIT_TOOLS: Record<string, string> = {
	Edit: "file_path",
	MultiEdit: "file_path",
	Write: "file_path",
	NotebookEdit: "notebook_path",
};

/** Long enough for the longest reply Claude Code writes by default, so nothing is cut short. */
export const TEXT_MAX = 128_000;

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

const steps: FieldDef<Step[]> = {
	key: "steps",
	label: "Recent steps",
	level: 1,
	extract: (input, current = [], _ctx, at) => {
		const e = input.hook_event_name;
		if (e === "SessionStart" && input.source === "clear") return null;
		// A subagent's own calls are summed up by the step that started it.
		const tool = str(input.tool_name);
		if (!tool || input.agent_id !== undefined) return undefined;
		const id = str(input.tool_use_id);
		if (e === "PreToolUse") {
			const step: Step = { ...describeTool(tool, input.tool_input, str(input.cwd)), at };
			return [...current, id ? { ...step, id } : step].slice(-STEPS_MAX);
		}
		const outcome =
			e === "PostToolUse"
				? "done"
				: e === "PostToolUseFailure"
					? "failed"
					: e === "PermissionDenied"
						? "denied"
						: undefined;
		if (!outcome) return undefined;
		const i = current.findLastIndex(
			(s) => !s.outcome && (id && s.id ? s.id === id : s.tool === tool),
		);
		if (i < 0) return undefined;
		return current.map((s, j) => (j === i ? { ...s, outcome } : s));
	},
};

/** What Claude last said while working, read from the transcript; cleared by your next prompt. */
const narration: FieldDef<string> = {
	key: "narration",
	label: "Claude's latest update",
	level: 2,
	extract: (input) => (RUN_START.has(input.hook_event_name) ? null : undefined),
};

/** The conversation's name: the one you gave it with /rename, or the one Claude Code wrote. */
const title: FieldDef<string> = {
	key: "title",
	label: "Conversation",
	level: 2,
};

const edited: FieldDef<string[]> = {
	key: "edited",
	label: "Edited by this session",
	level: 1,
	extract: (input, current = []) => {
		if (input.hook_event_name === "SessionStart" && input.source === "clear") return null;
		const tool = str(input.tool_name);
		const key = tool ? EDIT_TOOLS[tool] : undefined;
		const file = key ? str(record(input.tool_input)[key]) : undefined;
		if (input.hook_event_name !== "PostToolUse" || !file) return undefined;
		const dir = str(input.cwd);
		const path = sanitize(
			dir && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file,
			300,
		);
		return [path, ...current.filter((p) => p !== path)].slice(0, EDITED_MAX);
	},
};

const changes: FieldDef<WorkingChanges> = {
	key: "changes",
	label: "Not committed yet",
	level: 1,
};

const git: FieldDef<GitSummary> = {
	key: "git",
	label: "Commits and upstream",
	level: 1,
};

const gitCommits: FieldDef<GitCommit[]> = {
	key: "gitCommits",
	label: "Commits this session",
	level: 2,
};

const gitActivity: FieldDef<GitEvent[]> = {
	key: "gitActivity",
	label: "Git activity",
	level: 2,
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
	title,
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
	steps,
	edited,
	changes,
	git,
	gitCommits,
	gitActivity,
	error,
	prompt,
	permission,
	questions,
	plan,
	narration,
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
	at: number,
): void {
	for (const def of FIELDS) {
		const value = def.extract?.(input, fields[def.key], ctx, at);
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
