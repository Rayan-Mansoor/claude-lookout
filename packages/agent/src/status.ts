import {
	formatDuration,
	type SessionView,
	type Snapshot,
	STATE_LABELS,
	type ToolCall,
} from "@claude-lookout/protocol";

function describe(session: SessionView): string {
	const f = session.fields;
	const where = [f.project, f.branch && `(${f.branch})`].filter(Boolean).join(" ");
	const activity = f.activity as ToolCall | undefined;
	const doing = activity ? `${activity.tool}${activity.target ? ` ${activity.target}` : ""}` : "";
	return [where, doing].filter(Boolean).join(" · ");
}

export function renderStatus(snapshot: Snapshot | undefined, now = Date.now()): string {
	const open = snapshot?.sessions.filter((s) => s.state !== "gone") ?? [];
	if (!snapshot || open.length === 0) return "No Claude Code sessions are open.";
	const width = Math.max(...open.map((s) => STATE_LABELS[s.state].length));
	const lines = open.map((s) => {
		const label = STATE_LABELS[s.state].padEnd(width);
		const age = formatDuration(now - s.since).padStart(6);
		return `  ${label} ${age}  ${describe(s)}`;
	});
	return [`${snapshot.machine.name}`, ...lines].join("\n");
}
