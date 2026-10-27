import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS } from "@claude-lookout/protocol";

/** Claude Code's user settings file, honouring CLAUDE_CONFIG_DIR. */
export function claudeSettingsPath(): string {
	return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

interface HookHandler {
	type: string;
	command?: string;
	args?: string[];
	[key: string]: unknown;
}

interface MatcherGroup {
	matcher?: string;
	hooks?: HookHandler[];
	[key: string]: unknown;
}

export type Settings = Record<string, unknown> & { hooks?: Record<string, MatcherGroup[]> };

/** How a hook entry is recognised as ours: an installed copy, an npm install, or the source tree. */
function isLookoutHandler(handler: HookHandler): boolean {
	const [script, command] = handler.args ?? [];
	return (
		command === "hook" &&
		typeof script === "string" &&
		/claude-lookout|packages\/agent\/src\/cli\.ts$/.test(script)
	);
}

/** Settings with every claude-lookout hook removed and empty containers cleaned up. */
export function withoutLookoutHooks(settings: Settings): Settings {
	const next: Settings = structuredClone(settings);
	if (!next.hooks) return next;
	for (const [event, groups] of Object.entries(next.hooks)) {
		const kept = groups
			.map((group) => ({
				...group,
				hooks: (group.hooks ?? []).filter((h) => !isLookoutHandler(h)),
			}))
			.filter((group) => group.hooks.length > 0);
		if (kept.length > 0) next.hooks[event] = kept;
		else delete next.hooks[event];
	}
	if (Object.keys(next.hooks).length === 0) delete next.hooks;
	return next;
}

/**
 * Settings with claude-lookout subscribed to every event it reads. Runs in exec form so the
 * hook's parent is Claude Code itself, and async so Claude never waits on it.
 */
export function withLookoutHooks(settings: Settings, node: string, script: string): Settings {
	const next = withoutLookoutHooks(settings);
	next.hooks ??= {};
	for (const event of HOOK_EVENTS) {
		const handler: HookHandler = {
			type: "command",
			command: node,
			args: [script, "hook"],
			async: true,
			timeout: 10,
		};
		next.hooks[event] = [...(next.hooks[event] ?? []), { hooks: [handler] }];
	}
	return next;
}

/** A minimal line diff for showing a settings change before it's written. */
export function lineDiff(before: string, after: string): string {
	const a = before ? before.split("\n") : [];
	const b = after ? after.split("\n") : [];
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = lcs[i] as number[];
			const below = lcs[i + 1] as number[];
			row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (
			i < a.length &&
			(j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
		) {
			out.push(`- ${a[i++]}`);
		} else {
			out.push(`+ ${b[j++]}`);
		}
	}
	return out.join("\n");
}
