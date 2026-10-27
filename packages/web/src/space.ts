import {
	API,
	deriveSpace,
	isSecret,
	type MachineUpdate,
	open,
	type Snapshot,
	type SpaceKeys,
} from "@claude-lookout/protocol";
import { useEffect, useState } from "preact/hooks";
import { getItem, setItem } from "./storage.ts";

/** Where the last update from each machine is kept, still sealed, to show before reconnecting. */
export const LAST_UPDATES_KEY = "lastUpdates";

export type Connection = "connecting" | "live" | "retrying" | "denied";

export interface MachineState {
	id: string;
	snapshot: Snapshot;
	receivedAt: number;
	/**
	 * The machine's clock minus this device's, so times the machine reports read right here even
	 * when the two clocks disagree. Measured on snapshots that arrive live.
	 */
	clockOffset: number;
}

/** With no data at all for this long (the server sends a keepalive every 25s), the link is dead. */
const STALL_MS = 60_000;

/** Pull the view secret out of a pasted link (`…#k=SECRET`) or a bare secret. */
export function parseViewSecret(text: string): string | undefined {
	const trimmed = text.trim();
	const fromLink = trimmed.match(/[#&]k=([A-Za-z0-9_-]{43})/)?.[1];
	const secret = fromLink ?? trimmed;
	return isSecret(secret) ? secret : undefined;
}

/** Read server-sent events from a fetch stream, so the token can travel in a header. */
async function readEvents(
	response: Response,
	onEvent: (event: string, data: string) => void,
	onData: () => void = () => {},
): Promise<void> {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		onData();
		buffer += decoder.decode(value, { stream: true });
		let end = buffer.indexOf("\n\n");
		while (end >= 0) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			end = buffer.indexOf("\n\n");
			const event = block.match(/^event: (.+)$/m)?.[1];
			const data = block.match(/^data: (.+)$/m)?.[1];
			if (event && data) onEvent(event, data);
		}
	}
}

/**
 * Whether a decrypted snapshot may replace what is on screen for its machine. Updates can arrive
 * out of order or be replayed, and must never turn the view back; a snapshot filed under another
 * machine's name isn't that machine's.
 */
export function supersedes(
	snapshot: Snapshot,
	machine: string,
	held: { snapshot: Snapshot } | undefined,
): boolean {
	if (snapshot.machine?.id !== machine) return false;
	return !held || held.snapshot.sentAt <= snapshot.sentAt;
}

/** How long a machine can stay silent before it counts as offline (it reports every 30s). */
export const OFFLINE_AFTER_MS = 75_000;

/**
 * Live, decrypted state of every machine in the space. The stream only stays open while the
 * page is on screen, so a forgotten tab never keeps a relay busy.
 */
export function useSpace(viewSecret: string) {
	const [machines, setMachines] = useState<Map<string, MachineState>>(new Map());
	const [connection, setConnection] = useState<Connection>("connecting");
	// Server clock minus this device's clock, for judging how long ago a machine reported.
	const [clockOffset, setClockOffset] = useState(0);

	useEffect(() => {
		let generation = 0;
		let abort: AbortController | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		let keys: SpaceKeys | undefined;

		/** The newest update from each machine, still sealed, with when the machine sent it. */
		const saved = new Map<string, { update: MachineUpdate; sentAt: number }>();
		const offsets = new Map<string, number>();

		/** Show an update unless something newer from that machine is already on screen. */
		const apply = async (update: MachineUpdate, how: "stored" | "replayed" | "live") => {
			if (!keys) return;
			let snapshot: Snapshot;
			try {
				snapshot = await open<Snapshot>(keys.key, update.sealed);
			} catch {
				// Sealed with another key: a machine from an older setup. Nothing to show.
				return;
			}
			if (snapshot.machine?.id !== update.machine) return;
			if (how === "live") offsets.set(update.machine, snapshot.sentAt - Date.now());
			const clockOffset = offsets.get(update.machine) ?? 0;
			setMachines((prev) => {
				if (!supersedes(snapshot, update.machine, prev.get(update.machine))) return prev;
				const state = { id: update.machine, snapshot, receivedAt: update.receivedAt, clockOffset };
				return new Map(prev).set(update.machine, state);
			});
			const kept = saved.get(update.machine);
			if (how !== "stored" && (!kept || kept.sentAt < snapshot.sentAt)) {
				saved.set(update.machine, { update, sentAt: snapshot.sentAt });
				void setItem(
					LAST_UPDATES_KEY,
					[...saved.values()].map((s) => s.update),
				);
			}
			if (how === "stored" && !kept) saved.set(update.machine, { update, sentAt: snapshot.sentAt });
		};

		/** Show what each machine last reported straight away, before the connection is up. */
		const restore = async () => {
			const remembered = (await getItem<MachineUpdate[]>(LAST_UPDATES_KEY)) ?? [];
			keys ??= await deriveSpace(viewSecret);
			for (const update of remembered) await apply(update, "stored");
		};

		const connect = async () => {
			const current = ++generation;
			abort?.abort();
			const stream = new AbortController();
			abort = stream;
			// A link that drops without closing (say, switching from Wi-Fi to mobile data) would
			// otherwise look live forever.
			let stall: ReturnType<typeof setTimeout> | undefined;
			const fed = () => {
				clearTimeout(stall);
				stall = setTimeout(() => stream.abort(), STALL_MS);
			};
			fed();
			try {
				keys ??= await deriveSpace(viewSecret);
				const response = await fetch(API.events(keys.spaceId), {
					headers: { authorization: `Bearer ${keys.viewToken}` },
					signal: abort.signal,
					cache: "no-store",
				});
				if (response.status === 401) {
					clearTimeout(stall);
					setConnection("denied");
					return;
				}
				if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
				let ready = false;
				await readEvents(
					response,
					(event, data) => {
						if (event === "ready") {
							ready = true;
							attempt = 0;
							const info = JSON.parse(data) as { now?: number };
							if (typeof info.now === "number") setClockOffset(info.now - Date.now());
							setConnection("live");
						} else if (event === "machine") {
							// Before "ready" the server replays what it stored; after it, updates are live.
							void apply(JSON.parse(data) as MachineUpdate, ready ? "live" : "replayed");
						}
					},
					fed,
				);
				throw new Error("stream ended");
			} catch {
				clearTimeout(stall);
				if (current !== generation || document.visibilityState === "hidden") return;
				setConnection("retrying");
				attempt++;
				retryTimer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
			}
		};

		const onVisibility = () => {
			clearTimeout(retryTimer);
			if (document.visibilityState === "visible") {
				attempt = 0;
				void connect();
			} else {
				generation++;
				abort?.abort();
			}
		};

		void restore().catch(() => {});
		void connect();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			generation++;
			clearTimeout(retryTimer);
			abort?.abort();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [viewSecret]);

	return { machines, connection, clockOffset };
}

/** A clock that ticks every second, for "working for 3m" labels. */
export function useNow(): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return now;
}
