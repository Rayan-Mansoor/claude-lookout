import { formatDuration, type SessionView, type TaskProgress } from "@claude-lookout/protocol";
import { sessionPath } from "./router.ts";
import {
	gitAlerts,
	progressLine,
	sessionProject,
	sessionTitle,
	stateLabel,
	stateTone,
	summarize,
	text,
} from "./session-format.ts";
import { Link } from "./session-parts.tsx";

/** One row on the list: just enough to know whether to open it. */
export function SessionCard({
	machine,
	machineName,
	session,
	now,
}: {
	machine: string;
	/** Named on the card when it sits outside its computer's group. */
	machineName?: string | undefined;
	session: SessionView;
	now: number;
}) {
	const tone = stateTone(session);
	const tasks = session.fields.tasks as TaskProgress | undefined;
	const reason = summarize(session, now);
	const meta = [
		formatDuration(now - session.since),
		sessionProject(session),
		text(session.fields.branch),
		machineName,
	]
		.filter(Boolean)
		.join(" · ");
	const alerts = gitAlerts(session);
	const progress = progressLine(session);

	return (
		<Link
			href={sessionPath(machine, session.id)}
			class={`block rounded-2xl border bg-surface px-4 py-3.5 transition-colors hover:bg-surface-2 ${tone.card}`}
		>
			<div class="flex items-center gap-3">
				<span class={`size-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
				<span class="line-clamp-2 min-w-0 flex-1 break-words font-medium">
					{sessionTitle(session)}
				</span>
				<span class={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone.badge}`}>
					{stateLabel(session)}
				</span>
				<svg viewBox="0 0 20 20" class="size-4 shrink-0 text-muted" aria-hidden="true">
					<path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" />
				</svg>
			</div>
			{reason && (
				<p
					class={`mt-1.5 truncate pl-5.5 ${reason === text(session.fields.error) ? "text-halt" : ""}`}
				>
					{reason}
				</p>
			)}
			{alerts.length > 0 && (
				<p class="mt-0.5 truncate pl-5.5 text-sm font-medium text-lamp">{alerts.join(" · ")}</p>
			)}
			<p class="mt-0.5 truncate pl-5.5 text-sm text-muted">{meta}</p>
			{progress && <p class="mt-0.5 truncate pl-5.5 text-sm tabular-nums text-muted">{progress}</p>}
			{tasks && tasks.total > 0 && session.state !== "gone" && (
				<div class="mt-2.5 flex items-center gap-2 pl-5.5 pr-7">
					<div class="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
						<div
							class="h-full rounded-full bg-working transition-[width] duration-300"
							style={{ width: `${(tasks.done / tasks.total) * 100}%` }}
						/>
					</div>
					<span class="text-xs tabular-nums text-muted">
						{tasks.done}/{tasks.total}
					</span>
				</div>
			)}
		</Link>
	);
}
