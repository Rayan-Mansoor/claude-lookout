import type { Snapshot } from "@claude-lookout/protocol";

/** Somewhere snapshots go: the dashboard on this machine, or a relay. */
export interface Publisher {
	publish(snapshot: Snapshot, machineId: string): Promise<void>;
	stop(): void;
}

/**
 * Publish the latest snapshot at most every `intervalMs`, so a burst of hook events turns into
 * one update, and never with two publishes in flight.
 */
export function throttled(
	publisher: Publisher,
	intervalMs: number,
	onError: (err: Error) => void,
): (snapshot: Snapshot, machineId: string) => void {
	let pending: { snapshot: Snapshot; machineId: string } | undefined;
	let busy = false;
	let last = 0;

	const flush = async () => {
		if (busy || !pending) return;
		const wait = last + intervalMs - Date.now();
		if (wait > 0) {
			setTimeout(flush, wait);
			return;
		}
		const next = pending;
		pending = undefined;
		busy = true;
		last = Date.now();
		try {
			await publisher.publish(next.snapshot, next.machineId);
		} catch (err) {
			onError(err as Error);
		} finally {
			busy = false;
			if (pending) void flush();
		}
	};

	return (snapshot, machineId) => {
		pending = { snapshot, machineId };
		void flush();
	};
}
