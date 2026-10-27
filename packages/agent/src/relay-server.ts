import { join } from "node:path";
import { Hub } from "@claude-lookout/relay";
import { createHubServer, FileStore } from "@claude-lookout/relay/node";
import { lookoutHome } from "./home.ts";
import { findWebRoot } from "./transport/direct.ts";

export interface RelayServerOptions {
	host: string;
	port: number;
	/** Where the relay keeps registrations and the latest encrypted snapshots. */
	dataFile: string;
}

export const DEFAULT_RELAY_DATA = () => join(lookoutHome(), "relay.json");

/** Run a relay on this machine: the same one the Cloudflare Worker runs, for any Node host. */
export function runRelayServer(options: RelayServerOptions): void {
	const webRoot = findWebRoot();
	if (!webRoot) {
		console.error("Dashboard files not found next to claude-lookout; reinstall it.");
		process.exitCode = 1;
		return;
	}
	// Who may create spaces here; without a key, anyone who can reach the relay can.
	const relayKey = process.env.CLAUDE_LOOKOUT_RELAY_KEY || undefined;
	const hub = new Hub(new FileStore(options.dataFile), relayKey ? { relayKey } : {});
	const server = createHubServer({ hub, webRoot });
	server.on("error", (err) => {
		console.error(`Relay could not start: ${err.message}`);
		process.exitCode = 1;
	});
	server.listen(options.port, options.host, () => {
		console.log(`claude-lookout relay listening on http://${options.host}:${options.port}`);
		console.log(`Storing encrypted data in ${options.dataFile}`);
		console.log("Put it behind HTTPS, then run on each computer:");
		console.log(
			"  npx claude-lookout setup --relay https://<this server's address>" +
				(relayKey ? " --relay-key <the key>" : ""),
		);
	});
	const stop = () => {
		server.close(() => process.exit(0));
		// Open dashboard streams never end by themselves.
		server.closeAllConnections();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
