import {
	BLOCKED_STATES,
	formatDuration,
	type SessionView,
	type TaskProgress,
} from "@claude-lookout/protocol";
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
import { Lamp, Link } from "./session-parts.tsx";

/** One row on the list: just enough to know whether to open it. */
export function SessionCard({
	machine,
	machineName,
	session,
	now,
}: {
	machine: string;
	/** Named on the row when it sits outside its computer's group. */
	machineName?: string | undefined;
	session: SessionView;
	now: number;
}) {
	const tasks = session.fields.tasks as TaskProgress | undefined;
	const reason = summarize(session, now);
	const meta = [
		formatDuration(now - session.since),
		sessionProject(session),
		text(session.fields.branch),
		machineName,
	].filter(Boolean);
	const alerts = gitAlerts(session);
	const progress = progressLine(session);
	const needsYou = BLOCKED_STATES.includes(session.state);

	return (
		<li>
			<Link
				href={sessionPath(machine, session.id)}
				class={`grid grid-cols-[0.625rem_1fr] gap-x-3.5 py-3.5 transition-colors ${
					needsYou
						? "-mx-2.5 bg-lamp-soft px-2.5 shadow-[inset_2px_0_0_var(--lamp)]"
						: "hover:bg-surface-2"
				} ${session.state === "gone" ? "opacity-60" : ""}`}
			>
				<span class="pt-[7px]">
					<Lamp session={session} />
				</span>
				<div class="min-w-0">
					<p class="line-clamp-2 break-words font-medium">{sessionTitle(session)}</p>
					{reason && (
						<p class={`truncate ${reason === text(session.fields.error) ? "text-halt" : ""}`}>
							{reason}
						</p>
					)}
					{alerts.length > 0 && (
						<p class="truncate text-meta font-medium text-lamp">{alerts.join(" · ")}</p>
					)}
					<p class="mt-0.5 truncate text-meta text-muted">
						<span class={stateTone(session).text}>{stateLabel(session)}</span>
						{meta.map((part) => ` · ${part}`)}
					</p>
					{progress && <p class="truncate text-meta tabular-nums text-muted">{progress}</p>}
					{tasks && tasks.total > 0 && session.state !== "gone" && (
						<div class="mt-2 flex items-center gap-2.5">
							<div class="h-[3px] flex-1 overflow-hidden rounded-full bg-surface-2">
								<div
									class="h-full rounded-full bg-working transition-[width] duration-300"
									style={{ width: `${(tasks.done / tasks.total) * 100}%` }}
								/>
							</div>
							<span class="font-mono text-mono text-muted">
								{tasks.done}/{tasks.total}
							</span>
						</div>
					)}
				</div>
			</Link>
		</li>
	);
}
