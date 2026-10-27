import { formatDuration, type SessionView, type TaskProgress } from "@claude-lookout/protocol";
import { navigate, sessionPath } from "./router.ts";
import { sessionTitle, stateLabel, stateTone, summarize, text } from "./session-format.ts";

/** One row on the list: just enough to know whether to open it. */
export function SessionCard({
	machine,
	session,
	now,
}: {
	machine: string;
	session: SessionView;
	now: number;
}) {
	const tone = stateTone(session);
	const tasks = session.fields.tasks as TaskProgress | undefined;
	const line = [
		formatDuration(now - session.since),
		text(session.fields.branch),
		summarize(session),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<a
			href={sessionPath(machine, session.id)}
			class={`block rounded-2xl border bg-surface px-4 py-3.5 transition-colors hover:bg-surface-2 ${tone.card}`}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey) return;
				event.preventDefault();
				navigate(sessionPath(machine, session.id));
			}}
		>
			<div class="flex items-center gap-3">
				<span class={`size-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate font-medium">{sessionTitle(session)}</span>
				<span class={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone.badge}`}>
					{stateLabel(session)}
				</span>
				<svg viewBox="0 0 20 20" class="size-4 shrink-0 text-muted" aria-hidden="true">
					<path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" />
				</svg>
			</div>
			<p class="mt-1.5 truncate pl-5.5 text-sm text-muted">{line}</p>
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
		</a>
	);
}
