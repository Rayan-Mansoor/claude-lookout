import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { Hub } from "@claude-lookout/relay";
import { createHubServer, FileStore } from "@claude-lookout/relay/node";
import type { DirectTransport, SpaceSecrets } from "../config.ts";
import { paths } from "../home.ts";
import type { Publisher } from "./publisher.ts";

/** The built dashboard: next to the bundled CLI, or in the web package when run from source. */
export function findWebRoot(): string | undefined {
	const candidates = [
		process.argv[1] ? join(dirname(process.argv[1]), "web") : undefined,
		fileURLToPath(new URL("../../web/dist", import.meta.url)),
		fileURLToPath(new URL("../../../web/dist", import.meta.url)),
	];
	return candidates.find((dir) => dir && existsSync(join(dir, "index.html")));
}

/**
 * Serves the dashboard and its API from this machine, with the hub running in-process.
 * Reachable while Claude Code runs; put it behind Tailscale or a tunnel to see it elsewhere.
 */
export async function directPublisher(
	transport: DirectTransport,
	space: SpaceSecrets,
	log: (message: string) => void,
): Promise<Publisher> {
	const hub = new Hub(new FileStore(paths.hub()));
	const keys = await deriveSpace(space.view);
	const publishToken = await deriveToken(space.publish, "publish");
	const call = (path: string, method: string, body: unknown, token?: string) =>
		hub.fetch(
			new Request(`http://agent${path}`, {
				method,
				body: JSON.stringify(body),
				headers: token ? { authorization: `Bearer ${token}` } : {},
			}),
		);

	const registered = await call(API.space(keys.spaceId), "PUT", {
		viewHash: await hashToken(keys.viewToken),
		publishHash: await hashToken(publishToken),
	});
	if (!registered.ok) log(`could not register the space locally: HTTP ${registered.status}`);

	const webRoot = findWebRoot();
	const server = webRoot ? createHubServer({ hub, webRoot }) : undefined;
	if (!server) log("dashboard files not found; run `npm run build` in the repository");
	server?.on("error", (err) => log(`dashboard unavailable: ${err.message}`));
	server?.listen(transport.port, transport.host, () =>
		log(`dashboard on http://${transport.host}:${transport.port}`),
	);

	return {
		async publish(snapshot: Snapshot, machineId: string) {
			const sealed = await seal(keys.key, snapshot);
			await call(API.machine(keys.spaceId, machineId), "PUT", sealed, publishToken);
		},
		async notify(notice: Notice, options) {
			const sealed = await seal(keys.key, notice);
			const res = await call(
				API.notify(keys.spaceId, options?.silent),
				"POST",
				sealed,
				publishToken,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return (await res.json()) as NotifyResult;
		},
		stop() {
			server?.close();
			server?.closeAllConnections();
		},
	};
}
