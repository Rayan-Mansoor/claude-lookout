import {
	type Question,
	type SessionState,
	type SessionView,
	STATE_LABELS,
	type TaskProgress,
	type ToolCall,
} from "@claude-lookout/protocol";

/** Colour family for each state, shared by the list and the session screen. */
export const TONES: Record<SessionState, { dot: string; badge: string; card: string }> = {
	permission: { dot: "bg-lamp", badge: "bg-lamp-soft text-lamp", card: "border-lamp/60" },
	question: { dot: "bg-lamp", badge: "bg-lamp-soft text-lamp", card: "border-lamp/60" },
	plan: { dot: "bg-lamp", badge: "bg-lamp-soft text-lamp", card: "border-lamp/60" },
	working: { dot: "bg-working pulse", badge: "bg-working-soft text-working", card: "border-line" },
	finished: { dot: "bg-done", badge: "bg-done-soft text-done", card: "border-line" },
	interrupted: { dot: "bg-halt", badge: "bg-halt-soft text-halt", card: "border-line" },
	ready: { dot: "bg-idle", badge: "bg-idle-soft text-idle", card: "border-line" },
	gone: { dot: "bg-idle", badge: "bg-idle-soft text-idle", card: "border-line opacity-60" },
};

/** Order on screen: whatever needs you first, then what's running, then the rest. */
export const STATE_ORDER: SessionState[] = [
	"permission",
	"question",
	"plan",
	"working",
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

export function sessionTitle(session: SessionView): string {
	return text(session.fields.project) ?? "Claude Code";
}

/** "14:02" today, "Mon 14:02" before that. */
export function clockTime(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return new Date(now).toDateString() === date.toDateString()
		? time
		: `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** The one line under a session's title: what's happening, or what happened last. */
export function summarize(session: SessionView): string | undefined {
	const f = session.fields;
	const activity = f.activity as ToolCall | undefined;
	const tasks = f.tasks as TaskProgress | undefined;
	switch (session.state) {
		case "question":
			return (f.questions as Question[] | undefined)?.[0]?.question;
		case "plan":
			return "Plan ready for review";
		case "finished":
			return text(f.error) ?? text(f.lastMessage);
		case "working":
		case "permission":
			return activity ? describeActivity(activity) : tasks?.current;
		default:
			return undefined;
	}
}
