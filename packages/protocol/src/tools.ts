import { record, str } from "./hooks.ts";
import { sanitize } from "./redact.ts";

/** A short, human description of a tool call, e.g. { tool: "Bash", target: "npm test" }. */
export interface ToolCall {
	tool: string;
	target?: string;
}

const TARGET_KEYS: Record<string, string> = {
	Bash: "command",
	Read: "file_path",
	Write: "file_path",
	Edit: "file_path",
	MultiEdit: "file_path",
	NotebookEdit: "notebook_path",
	Grep: "pattern",
	Glob: "pattern",
	WebFetch: "url",
	WebSearch: "query",
	Task: "description",
	Agent: "description",
	Skill: "skill",
};

function relativeTo(cwd: string | undefined, path: string): string {
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	return path;
}

export function describeTool(
	name: string,
	input: unknown,
	cwd: string | undefined,
	max = 160,
): ToolCall {
	const args = record(input);
	const key = TARGET_KEYS[name];
	let target = key ? str(args[key]) : undefined;
	if (!target && name.startsWith("mcp__")) {
		const [, server, tool] = name.split("__");
		return { tool: `${server ?? "mcp"} · ${tool ?? name}` };
	}
	if (!target) return { tool: name };
	if (key?.endsWith("_path")) target = relativeTo(cwd, target);
	const firstLine = target.split("\n", 1)[0] ?? target;
	return { tool: name, target: sanitize(firstLine, max) };
}
