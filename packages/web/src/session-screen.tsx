import type { Section } from "./router.ts";
import { SessionOverview } from "./session-overview.tsx";
import { ScreenHeader } from "./session-parts.tsx";
import { SessionSection } from "./session-sections.tsx";
import type { MachineState } from "./space.ts";

/** One session, or one part of it, kept live. */
export function SessionScreen({
	machine,
	sessionId,
	section,
	now,
	loading,
	offlineFor,
}: {
	machine: MachineState | undefined;
	sessionId: string;
	section?: Section | undefined;
	now: number;
	loading: boolean;
	/** How long the machine has been silent, when it counts as offline. */
	offlineFor?: number | undefined;
}) {
	const session = machine?.snapshot.sessions.find((s) => s.id === sessionId);

	return (
		<main class="mx-auto max-w-[680px] px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-12 lg:pt-10">
			{!machine || !session ? (
				<>
					<ScreenHeader title="" backLabel="Back" />
					<p class="mt-10 text-center text-muted">
						{loading ? "Loading…" : "This session has closed and is no longer shown."}
					</p>
				</>
			) : section ? (
				<SessionSection
					section={section}
					session={session}
					machineName={machine.snapshot.machine.name}
					now={now}
				/>
			) : (
				<SessionOverview
					machineId={machine.id}
					machineName={machine.snapshot.machine.name}
					session={session}
					now={now}
					offlineFor={offlineFor}
				/>
			)}
		</main>
	);
}
