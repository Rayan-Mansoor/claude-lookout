import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { DEFAULT_LEVEL, type Level, type Machine, randomSecret } from "@claude-lookout/protocol";
import { paths } from "./home.ts";

/** The secrets of the space this machine reports to. Never leave the machine as-is. */
export interface SpaceSecrets {
	/** Lets anyone holding it see the dashboard; it is the view link. */
	view: string;
	/** Lets machines publish into the space. */
	publish: string;
	/** Reserved for acting on sessions from the dashboard. */
	control: string;
}

/** Serve the dashboard from this machine while Claude Code runs. */
export interface DirectTransport {
	mode: "direct";
	host: string;
	port: number;
	/** The address viewers use, when it differs from host:port (e.g. a Tailscale name). */
	publicUrl?: string;
}

/** Publish to a relay on the internet, so the dashboard works from anywhere, any time. */
export interface RelayTransport {
	mode: "relay";
	url: string;
	/** The key the relay's owner set, if they set one. */
	key?: string;
}

export type Transport = DirectTransport | RelayTransport;

export interface Config {
	machine: Machine;
	/** Highest field level that leaves this machine. */
	level: Level;
	space: SpaceSecrets;
	transport: Transport;
}

export const DEFAULT_PORT = 4777;

export function newSpace(): SpaceSecrets {
	return { view: randomSecret(), publish: randomSecret(), control: randomSecret() };
}

export function defaultConfig(): Config {
	return {
		machine: { id: randomUUID(), name: hostname().replace(/\.local$/, "") },
		level: DEFAULT_LEVEL,
		space: newSpace(),
		transport: { mode: "direct", host: "127.0.0.1", port: DEFAULT_PORT },
	};
}

/**
 * This machine's config, or a fresh one when there is none yet. A config that can't be read is
 * an error, never silently replaced by a fresh one.
 */
export function loadConfig(path = paths.config()): Config {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
		throw new Error(`Can't read ${path}: ${(err as Error).message}`);
	}
	let saved: unknown;
	try {
		saved = JSON.parse(text);
	} catch {
		saved = undefined;
	}
	if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
		throw new Error(`${path} is damaged. Fix it, or move it away to start over with a new one.`);
	}
	return { ...defaultConfig(), ...saved };
}

/** Where a viewer opens the dashboard; the secret rides in the #fragment, never sent to a server. */
export function viewLink(config: Config): string {
	return `${dashboardUrl(config.transport)}/#k=${config.space.view}`;
}

export function dashboardUrl(transport: Transport): string {
	if (transport.mode === "relay") return transport.url.replace(/\/+$/, "");
	if (transport.publicUrl) return transport.publicUrl.replace(/\/+$/, "");
	const host =
		transport.host === "127.0.0.1" || transport.host === "0.0.0.0" ? "localhost" : transport.host;
	return `http://${host}:${transport.port}`;
}

const JOIN_PREFIX = "cl1.";

/** Everything another machine needs to report into the same space. Contains the publish secret. */
export function joinCode(config: Config): string | undefined {
	if (config.transport.mode !== "relay") return undefined;
	const { view, publish, control } = config.space;
	const { url, key } = config.transport;
	const payload = JSON.stringify({
		u: url,
		v: view,
		p: publish,
		c: control,
		...(key ? { k: key } : {}),
	});
	return JOIN_PREFIX + Buffer.from(payload).toString("base64url");
}

export function parseJoinCode(code: string): Pick<Config, "space" | "transport"> | undefined {
	if (!code.startsWith(JOIN_PREFIX)) return undefined;
	try {
		const { u, v, p, c, k } = JSON.parse(
			Buffer.from(code.slice(JOIN_PREFIX.length), "base64url").toString("utf8"),
		);
		if (![u, v, p, c].every((s) => typeof s === "string")) return undefined;
		if (k !== undefined && typeof k !== "string") return undefined;
		return {
			space: { view: v, publish: p, control: c },
			transport: { mode: "relay", url: u, ...(k ? { key: k } : {}) },
		};
	} catch {
		return undefined;
	}
}
