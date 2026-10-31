import {
	API,
	deriveSpace,
	deriveToken,
	hashToken,
	type Notice,
	type NotifyResult,
	type Snapshot,
	seal,
} from "@claude-lookout/protocol";
import type { RelayTransport, SpaceSecrets } from "../config.ts";
import type { Publisher } from "./publisher.ts";

/** Publishes sealed snapshots to a relay, registering the space on first contact. */
export async function relayPublisher(
	transport: RelayTransport,
	space: SpaceSecrets,
	log: (message: string) => void,
): Promise<Publisher> {
	const base = transport.url.replace(/\/+$/, "");
	const keys = await deriveSpace(space.view);
	const publishToken = await deriveToken(space.publish, "publish");
	const registration = {
		viewHash: await hashToken(keys.viewToken),
		publishHash: await hashToken(publishToken),
		...(transport.key ? { relayKey: transport.key } : {}),
	};
	let registered = false;

	const register = async () => {
		const res = await fetch(`${base}${API.space(keys.spaceId)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(registration),
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 409) {
			throw new Error("the relay already has this space with other credentials; run setup again");
		}
		if (res.status === 403) {
			throw new Error("the relay asks for its key; run setup again with --relay-key");
		}
		if (!res.ok) throw new Error(`relay refused registration: HTTP ${res.status}`);
		registered = true;
		log(`registered with ${base}`);
	};

	const put = async (snapshot: Snapshot, machineId: string) =>
		fetch(`${base}${API.machine(keys.spaceId, machineId)}`, {
			method: "PUT",
			headers: { "content-type": "application/json", authorization: `Bearer ${publishToken}` },
			body: JSON.stringify(await seal(keys.key, snapshot)),
			signal: AbortSignal.timeout(10_000),
		});

	return {
		async publish(snapshot, machineId) {
			if (!registered) await register();
			let res = await put(snapshot, machineId);
			if (res.status === 401) {
				// The relay lost its data (e.g. redeployed with a fresh store): register again.
				await register();
				res = await put(snapshot, machineId);
			}
			if (!res.ok) throw new Error(`relay refused the update: HTTP ${res.status}`);
		},
		async notify(notice: Notice, options) {
			if (!registered) await register();
			const send = async () =>
				fetch(`${base}${API.notify(keys.spaceId, options?.silent)}`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${publishToken}` },
					body: JSON.stringify(await seal(keys.key, notice)),
					signal: AbortSignal.timeout(15_000),
				});
			let res = await send();
			if (res.status === 401) {
				// The relay lost its data (e.g. redeployed with a fresh store): register again.
				await register();
				res = await send();
			}
			if (!res.ok) throw new Error(`relay refused the notification: HTTP ${res.status}`);
			return (await res.json()) as NotifyResult;
		},
		stop() {},
	};
}
