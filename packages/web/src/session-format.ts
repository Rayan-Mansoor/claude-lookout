import {
	formatDuration,
	type GitEvent,
	type GitSummary,
	type PermissionRequest,
	plainLine,
	type Question,
	type SessionState,
	type SessionView,
	STATE_LABELS,
	type Step,
	type Subagent,
	type TaskProgress,
	type ToolCall,
	type WorkingChanges,
} from "@claude-lookout/protocol";

/** A step running at least this long is called out, so a stuck one stands out. */
const LONG_STEP_MS = 60_000;

/**
 * How each state lights a session's lamp, and the colour its name is written in. Colour, fill and
 * motion differ together, so states tell apart without relying on colour alone.
 */
export const TONES: Record<SessionState, { lamp: string; text: string }> = {
	permission: { lamp: "bg-lamp ring-4 ring-lamp/25", text: "text-lamp" },
	question: { lamp: "bg-lamp ring-4 ring-lamp/25", text: "text-lamp" },
	plan: { lamp: "bg-lamp ring-4 ring-lamp/25", text: "text-lamp" },
	working: { lamp: "bg-working breathe", text: "text-working" },
	background: { lamp: "border-2 border-working", text: "text-working" },
	finished: { lamp: "bg-done", text: "text-done" },
	interrupted: { lamp: "bg-halt", text: "text-halt" },
	ready: { lamp: "border-2 border-idle", text: "text-muted" },
	gone: { lamp: "border-2 border-idle", text: "text-muted" },
};

/** Order on screen: whatever needs you first, then what's running, then the rest. */
export const STATE_ORDER: SessionState[] = [
	"permission",
	"question",
	"plan",
	"working",
	"background",
	"finished",
	"interrupted",
	"ready",
	"gone",
];

/** A run that ended in an error stops like any other; it is shown as failed instead. */
export function runFailed(session: SessionView): boolean {
	return session.state === "finished" && text(session.fields.error) !== undefined;
}

export function stateTone(session: SessionView): (typeof TONES)[SessionState] {
	return runFailed(session) ? TONES.interrupted : TONES[session.state];
}

export function stateLabel(session: SessionView): string {
	return runFailed(session) ? "Run failed" : STATE_LABELS[session.state];
}

/** Where a session sorts: a failed run comes right after whatever needs you. */
export function urgency(session: SessionView): number {
	return runFailed(session)
		? STATE_ORDER.indexOf("working") - 0.5
		: STATE_ORDER.indexOf(session.state);
}

export const MODE_LABELS: Record<string, string> = {
	default: "Ask before acting",
	plan: "Plan mode",
	acceptEdits: "Accept edits",
	auto: "Auto",
	dontAsk: "Don't ask",
	bypassPermissions: "Bypass permissions",
};

export const START_LABELS: Record<string, string> = {
	startup: "New session",
	resume: "Resumed",
	clear: "After /clear",
	compact: "After compaction",
	fork: "Forked",
};

export function label(labels: Record<string, string>, value: unknown): string | undefined {
	return typeof value === "string" ? (labels[value] ?? value) : undefined;
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function describeActivity(call: ToolCall): string {
	return call.target ? `${call.tool} · ${call.target}` : call.tool;
}

/** The conversation's name, or the project when it has none yet. */
export function sessionTitle(session: SessionView): string {
	return text(session.fields.title) ?? text(session.fields.project) ?? "Claude Code";
}

/** The project, when the title doesn't already say it. */
export function sessionProject(session: SessionView): string | undefined {
	return text(session.fields.title) ? text(session.fields.project) : undefined;
}

/** "14:02" today, "Mon 14:02" before that. */
export function clockTime(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return new Date(now).toDateString() === date.toDateString()
		? time
		: `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "7 files changed · +312 −48 · 2 commits · 1 not pushed": how far a session has got, or undefined before any change. Problems are left to `gitAlerts`. */
export function progressLine(session: SessionView): string | undefined {
	const f = session.fields;
	const changes = f.changes as WorkingChanges | undefined;
	const git = f.git as GitSummary | undefined;
	const commits = git?.commits ?? 0;
	const edited = Array.isArray(f.edited) ? f.edited.length : 0;
	const parts: string[] = [];
	if (changes) {
		parts.push(`${plural(changes.total, "file")} changed`);
		if (changes.added || changes.removed) parts.push(`+${changes.added} −${changes.removed}`);
	} else if (edited && !commits) {
		parts.push(`${plural(edited, "file")} edited`);
	}
	if (commits) parts.push(plural(commits, "commit"));
	if (git?.earlier) parts.push(`${plural(git.earlier, "earlier commit")} rewritten`);
	if (git?.unpushed) parts.push(`${git.unpushed} not pushed`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "Rebase stopped at 2 of 5": a git operation left half-way. */
export function busyLine(busy: NonNullable<GitSummary["busy"]>): string {
	if (busy.kind === "rebase") {
		return busy.step && busy.total
			? `Rebase stopped at ${busy.step} of ${busy.total}`
			: "Rebase stopped";
	}
	if (busy.kind === "bisect") return "Bisecting";
	return `${busy.kind === "merge" ? "Merge" : busy.kind === "revert" ? "Revert" : "Cherry-pick"} not finished`;
}

/** "2 ahead, 1 behind origin/main", or "Up to date with origin/main". */
export function upstreamLine(upstream: NonNullable<GitSummary["upstream"]>): string {
	const { ref, ahead, behind } = upstream;
	if (!ahead && !behind) return `Up to date with ${ref}`;
	if (!behind) return `${ahead} ahead of ${ref}`;
	if (!ahead) return `${behind} behind ${ref}`;
	return `${ahead} ahead, ${behind} behind ${ref}`;
}

const quote = (text: string | undefined) => `“${text ?? ""}”`;

/** What one git event did, in a sentence. */
export function describeGitEvent(e: GitEvent): string {
	const onto = e.ref ? ` onto ${e.ref}` : "";
	const count = e.count ?? 0;
	switch (e.kind) {
		case "commit":
			return `Committed ${quote(e.subject)}`;
		case "amend":
			return `Amended ${quote(e.subject)}${e.earlier ? ", a commit from before this session" : ""}`;
		case "rebase": {
			if (e.running) return `Rebasing${onto}`;
			if (e.aborted) return `Gave up rebasing${onto}`;
			const parts = [`Rebased ${plural(count, "commit")}${onto}`];
			const folded = e.folded ?? [];
			if (folded.length === 1) parts.push(`folded a fix into ${quote(folded[0])}`);
			else if (folded.length > 1)
				parts.push(`folded fixes into ${plural(folded.length, "commit")}`);
			if (e.reworded) parts.push(`reworded ${e.reworded}`);
			if (e.removed) parts.push(`removed ${e.removed}`);
			const text = parts.join(", ");
			return e.earlier ? `${text}, rewriting commits from before this session` : text;
		}
		case "reset":
			return count ? `Reset to ${e.ref}, dropping ${plural(count, "commit")}` : `Reset to ${e.ref}`;
		case "merge":
			if (e.fastForward) return `Fast-forwarded to ${e.ref}, ${plural(count, "commit")}`;
			return `Merged ${e.ref ?? quote(e.subject)}${count ? `, ${plural(count, "commit")}` : ""}`;
		case "pull": {
			if (e.running) return "Pulling and rebasing";
			if (e.aborted) return "Gave up rebasing a pull";
			const pulled = count ? `Pulled ${plural(count, "commit")}` : "Pulled, nothing new";
			return e.replayed
				? `${pulled}, replaying ${plural(e.replayed, "local commit")} on top`
				: pulled;
		}
		case "fetch":
			return `Fetched ${plural(count, "new commit")} on ${e.ref}`;
		case "push":
			if (e.count === undefined) return `Pushed ${e.ref} for the first time`;
			return `${e.forced ? "Force-pushed" : "Pushed"} ${plural(count, "commit")} to ${e.ref}`;
		case "switch":
			return `Switched from ${e.from} to ${e.ref}`;
		case "cherry-pick":
			return `Cherry-picked ${quote(e.subject)}`;
		case "revert": {
			const reverted = e.subject?.match(/^Revert "(.*)"$/)?.[1];
			return reverted ? `Reverted ${quote(reverted)}` : `Reverted with ${quote(e.subject)}`;
		}
		case "branch-created":
			return `Created branch ${e.ref}`;
		case "branch-deleted":
			return `Deleted branch ${e.ref}`;
		case "tag-created":
			return `Tagged ${e.ref}`;
		case "tag-deleted":
			return `Deleted tag ${e.ref}`;
		case "stash":
			return count > 1 ? `Stashed ${count} sets of changes` : "Stashed changes";
		case "unstash":
			return count > 1 ? `Popped or dropped ${count} stashes` : "Popped or dropped a stash";
		default:
			return e.subject ?? "Moved HEAD";
	}
}

/** The tool call still running, when Claude is mid-step. */
export function runningStep(session: SessionView): Step | undefined {
	if (session.state !== "working" && session.state !== "permission") return undefined;
	const last = (session.fields.steps as Step[] | undefined)?.at(-1);
	return last && !last.outcome ? last : undefined;
}

/** "Bash · npm test", or "Bash for 4m · npm test" once it has run long. */
export function describeStep(step: Step, now: number): string {
	const running = now - step.at;
	return running >= LONG_STEP_MS
		? `${step.tool} for ${formatDuration(running)}${step.target ? ` · ${step.target}` : ""}`
		: describeActivity(step);
}

/** The one line under a session's title: what's happening, or what happened last. */
export function summarize(session: SessionView, now: number): string | undefined {
	const f = session.fields;
	const activity = f.activity as ToolCall | undefined;
	const tasks = f.tasks as TaskProgress | undefined;
	switch (session.state) {
		case "question":
			return plainLine((f.questions as Question[] | undefined)?.[0]?.question);
		case "plan":
			return "Plan ready for review";
		case "background":
		case "finished":
			return text(f.error) ?? plainLine(text(f.lastMessage));
		case "permission": {
			const request = f.permission as PermissionRequest | undefined;
			return request ? describeActivity(request) : activity && describeActivity(activity);
		}
		case "working": {
			const step = runningStep(session);
			if (step && now - step.at >= LONG_STEP_MS) return describeStep(step, now);
			return (
				plainLine(text(f.narration)) ?? (activity ? describeActivity(activity) : tasks?.current)
			);
		}
		default:
			return undefined;
	}
}

/** Problems in the repository that won't clear by themselves: a git operation left half-way, files in conflict. */
export function gitAlerts(session: SessionView): string[] {
	const git = session.fields.git as GitSummary | undefined;
	const changes = session.fields.changes as WorkingChanges | undefined;
	const alerts: string[] = [];
	if (git?.busy) alerts.push(busyLine(git.busy));
	const conflicts = changes?.files.filter((file) => file.status === "conflict").length ?? 0;
	if (conflicts) alerts.push(`${plural(conflicts, "file")} in conflict`);
	return alerts;
}

/** "Opus 5.5" for "claude-opus-5-5", or the model as Claude Code named it. */
export function modelName(model: string | undefined): string | undefined {
	const match = model?.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/);
	if (!match?.[1] || !match[2]) return model;
	const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
	return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/** One part of a section's one-line summary; a tone colours it, `glued` joins it with a space. */
export interface DigestPart {
	text: string;
	tone?: "lamp" | "halt" | "done";
	glued?: true;
}

/** What the conversation screen holds, or undefined when there is nothing to read. */
export function conversationDigest(session: SessionView, now: number): DigestPart[] | undefined {
	const f = session.fields;
	const ended = session.state === "finished" || session.state === "background";
	if (text(f.lastMessage) && ended) {
		return [{ text: `Reply ${formatDuration(now - session.since)} ago` }];
	}
	if (text(f.narration)) return [{ text: "Latest update" }];
	if (text(f.lastMessage)) return [{ text: "Last reply" }];
	if (text(f.prompt)) return [{ text: "Your prompt" }];
	return undefined;
}

/** "Bash 1m · 5 of 8 tasks · 14 recent steps · 1 failed" */
export function activityDigest(session: SessionView, now: number): DigestPart[] | undefined {
	const f = session.fields;
	const steps = (f.steps as Step[] | undefined) ?? [];
	const tasks = f.tasks as TaskProgress | undefined;
	const subagents = (f.subagents as Subagent[] | undefined) ?? [];
	if (!steps.length && !tasks?.total && !subagents.length) return undefined;
	const parts: DigestPart[] = [];
	const step = runningStep(session);
	if (step) {
		parts.push({
			text:
				session.state === "permission"
					? `Waiting on ${step.tool}`
					: `${step.tool} ${formatDuration(now - step.at)}`,
		});
	}
	if (tasks?.total) parts.push({ text: `${tasks.done} of ${tasks.total} tasks` });
	if (subagents.length) parts.push({ text: plural(subagents.length, "subagent") });
	if (steps.length) parts.push({ text: plural(steps.length, "recent step") });
	const failed = steps.filter((s) => s.outcome === "failed").length;
	const denied = steps.filter((s) => s.outcome === "denied").length;
	if (failed) parts.push({ text: `${failed} failed`, tone: "halt" });
	if (denied) parts.push({ text: `${denied} not allowed`, tone: "halt" });
	return parts;
}

/** "1 in conflict · 6 files changed +120 −34", or what the session edited before git knew of it. */
export function filesDigest(session: SessionView): DigestPart[] | undefined {
	const f = session.fields;
	const changes = f.changes as WorkingChanges | undefined;
	const edited = (f.edited as string[] | undefined) ?? [];
	if (!changes)
		return edited.length ? [{ text: `${plural(edited.length, "file")} edited` }] : undefined;
	const parts: DigestPart[] = [];
	const conflicts = changes.files.filter((file) => file.status === "conflict").length;
	if (conflicts) parts.push({ text: `${conflicts} in conflict`, tone: "lamp" });
	parts.push({ text: `${plural(changes.total, "file")} changed` });
	if (changes.added) parts.push({ text: `+${changes.added}`, tone: "done", glued: true });
	if (changes.removed) parts.push({ text: `−${changes.removed}`, tone: "halt", glued: true });
	return parts;
}

/** "Rebase stopped at 2 of 5 · 3 commits · 3 not pushed", or where the branch stands. */
export function gitDigest(session: SessionView): DigestPart[] | undefined {
	const f = session.fields;
	const git = f.git as GitSummary | undefined;
	const activity = (f.gitActivity as GitEvent[] | undefined) ?? [];
	if (!git && !activity.length) return undefined;
	const parts: DigestPart[] = [];
	if (git?.busy) parts.push({ text: busyLine(git.busy), tone: "lamp" });
	if (git?.commits) parts.push({ text: plural(git.commits, "commit") });
	if (git?.earlier) parts.push({ text: `${git.earlier} rewritten` });
	if (git?.unpushed) parts.push({ text: `${git.unpushed} not pushed`, tone: "lamp" });
	if (git?.upstream?.behind) parts.push({ text: `${git.upstream.behind} behind` });
	if (parts.length) return parts;
	if (git?.upstream && !git.upstream.ahead) return [{ text: "Up to date" }];
	return [{ text: plural(activity.length, "git event") }];
}

/** "Opus 5.5 · Auto · main" */
export function detailsDigest(session: SessionView): DigestPart[] {
	const f = session.fields;
	return [modelName(text(f.model)), label(MODE_LABELS, f.mode), text(f.branch)]
		.filter((part): part is string => !!part)
		.map((part) => ({ text: part }));
}
