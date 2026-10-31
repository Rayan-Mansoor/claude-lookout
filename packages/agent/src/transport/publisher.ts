import type { Notice, NotifyResult, Snapshot } from "@claude-lookout/protocol";
import { type Hold, noHold } from "../hold.ts";

/** Somewhere snapshots go: the dashboard on this machine, or a relay. */
export interface Publisher {
	publish(snapshot: Snapshot, machineId: string): Promise<void>;
	/** Send a push notification to every device that turned them on. */
	notify(notice: Notice): Promise<NotifyResult>;
	stop(): void;
}

/**
 * Publish the latest snapshot at most every `intervalMs`, so a burst of hook events turns into
 * one update, and never with two publishes in flight. A publish sent with `{ hold: true }` keeps
 * `hold` until it, or a later snapshot, has gone out or failed.
 */
export function throttled(
	publisher: Publisher,
	intervalMs: number,
	onError: (err: Error) => void,
	hold: Hold = noHold,
): (snapshot: Snapshot, machineId: string, options?: { hold?: boolean }) => void {
	let pending: { snapshot: Snapshot; machineId: string } | undefined;
	let busy = false;
	let last = 0;
	let release: (() => void) | undefined;

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
			else {
				release?.();
				release = undefined;
			}
		}
	};

	return (snapshot, machineId, options) => {
		pending = { snapshot, machineId };
		if (options?.hold) release ??= hold.take();
		void flush();
	};
}
