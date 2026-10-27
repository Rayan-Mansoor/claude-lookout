import { connect } from "node:net";
import type { HookEvent, Snapshot } from "@claude-lookout/protocol";
import { paths } from "./home.ts";

/** Messages the hook and CLI send to the agent over its unix socket, one JSON object per line. */
export type Request = { type: "event"; event: HookEvent } | { type: "snapshot" };

/** Send one request and resolve with the agent's reply line, if any. */
export function request(message: Request, timeoutMs = 1000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(paths.socket());
		let reply = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("agent did not answer"));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.end(`${JSON.stringify(message)}\n`));
		socket.on("data", (chunk) => {
			reply += chunk;
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			resolve(reply.trim());
		});
	});
}

export async function fetchSnapshot(): Promise<Snapshot | undefined> {
	try {
		const reply = await request({ type: "snapshot" });
		return reply ? (JSON.parse(reply) as Snapshot) : undefined;
	} catch {
		return undefined;
	}
}
