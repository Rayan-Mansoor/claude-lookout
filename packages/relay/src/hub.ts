import {
	hashToken,
	type MachineUpdate,
	type Sealed,
	type SpaceRegistration,
} from "@claude-lookout/protocol";
import type { HubStore } from "./store.ts";

const ROUTE = /^\/api\/spaces\/([0-9a-f]{32})(?:\/(events|machines\/([A-Za-z0-9-]{1,64})))?$/;
/** Room for the largest snapshot a machine sends, once sealed. */
export const MAX_BODY = 1536 * 1024;
const MAX_MACHINES = 32;
const KEEPALIVE_MS = 25_000;

type Send = (event: string, data: unknown) => void;

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}

const error = (status: number, message: string) => json(status, { error: message });

function bearer(request: Request): string | undefined {
	return request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
}

async function readJson<T>(request: Request): Promise<T | undefined> {
	// Refuse an oversized body before reading it, rather than after holding all of it in memory.
	if (Number(request.headers.get("content-length")) > MAX_BODY) return undefined;
	const text = await request.text();
	if (text.length > MAX_BODY) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function isSealed(value: unknown): value is Sealed {
	const v = value as Partial<Sealed> | undefined;
	return typeof v?.iv === "string" && typeof v.ct === "string";
}

/**
 * The server side of claude-lookout: stores each machine's latest sealed snapshot per space
 * and streams updates to viewers. It never holds a key, so it can't read what it relays.
 * Runs unchanged inside the agent, a Cloudflare Durable Object, or a Node server.
 */
export interface HubOptions {
	/**
	 * End viewer streams after this long; the dashboard reconnects while it's on screen.
	 * Bounds how long a forgotten tab keeps a hosted relay busy.
	 */
	maxStreamMs?: number;
	/**
	 * When set, only a registration that presents this key creates a space, so strangers can't
	 * store data on a relay they found. Spaces already registered keep working without it.
	 */
	relayKey?: string;
}

export class Hub {
	private readonly store: HubStore;
	private readonly options: HubOptions;
	private readonly viewers = new Map<string, Set<Send>>();

	constructor(store: HubStore, options: HubOptions = {}) {
		this.store = store;
		this.options = options;
	}

	async fetch(request: Request): Promise<Response> {
		const match = new URL(request.url).pathname.match(ROUTE);
		if (!match) return error(404, "not found");
		const [, space = "", sub, machine] = match;

		if (!sub && request.method === "PUT") return this.register(space, request);
		if (sub === "events" && request.method === "GET") return this.events(space, request);
		if (machine && request.method === "PUT") return this.publish(space, machine, request);
		return error(405, "method not allowed");
	}

	/** Register a space, or confirm an existing registration with the same credentials. */
	private async register(space: string, request: Request): Promise<Response> {
		const body = await readJson<SpaceRegistration>(request);
		if (
			!body ||
			!/^[0-9a-f]{64}$/.test(body.viewHash) ||
			!/^[0-9a-f]{64}$/.test(body.publishHash)
		) {
			return error(400, "invalid registration");
		}
		const key = this.options.relayKey;
		if (key && (await hashToken(String(body.relayKey ?? ""))) !== (await hashToken(key))) {
			return error(403, "this relay needs its key to register");
		}
		const existing = await this.store.get<SpaceRegistration>(`space:${space}`);
		if (existing) {
			const same = existing.viewHash === body.viewHash && existing.publishHash === body.publishHash;
			return same ? json(200, { ok: true }) : error(409, "space already registered");
		}
		await this.store.put(`space:${space}`, {
			viewHash: body.viewHash,
			publishHash: body.publishHash,
		});
		return json(201, { ok: true });
	}

	private async authorize(
		space: string,
		request: Request,
		role: keyof SpaceRegistration,
	): Promise<boolean> {
		const token = bearer(request);
		const registration = await this.store.get<SpaceRegistration>(`space:${space}`);
		return !!token && !!registration && registration[role] === (await hashToken(token));
	}

	private async publish(space: string, machine: string, request: Request): Promise<Response> {
		if (!(await this.authorize(space, request, "publishHash"))) return error(401, "unauthorized");
		const sealed = await readJson<Sealed>(request);
		if (!isSealed(sealed)) return error(400, "invalid snapshot");
		const machines = await this.store.list<MachineUpdate>(`machine:${space}:`);
		if (!machines.has(`machine:${space}:${machine}`) && machines.size >= MAX_MACHINES) {
			return error(429, "too many machines");
		}
		const update: MachineUpdate = { machine, sealed, receivedAt: Date.now() };
		await this.store.put(`machine:${space}:${machine}`, update);
		this.broadcast(space, "machine", update);
		return json(200, { ok: true });
	}

	private async events(space: string, request: Request): Promise<Response> {
		if (!(await this.authorize(space, request, "viewHash"))) return error(401, "unauthorized");
		const machines = await this.store.list<MachineUpdate>(`machine:${space}:`);
		const encoder = new TextEncoder();
		let cleanup = () => {};

		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const send: Send = (event, data) => {
					try {
						controller.enqueue(
							encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
						);
					} catch {
						cleanup();
					}
				};
				for (const update of machines.values()) send("machine", update);
				// The server's clock, so viewers can tell how long ago a machine last reported.
				send("ready", { now: Date.now() });
				const keepalive = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": keepalive\n\n"));
					} catch {
						cleanup();
					}
				}, KEEPALIVE_MS);
				const expiry = this.options.maxStreamMs
					? setTimeout(() => {
							cleanup();
							controller.close();
						}, this.options.maxStreamMs)
					: undefined;
				const set = this.viewers.get(space) ?? new Set();
				set.add(send);
				this.viewers.set(space, set);
				cleanup = () => {
					clearInterval(keepalive);
					if (expiry) clearTimeout(expiry);
					set.delete(send);
					if (set.size === 0) this.viewers.delete(space);
				};
				request.signal?.addEventListener("abort", () => cleanup());
			},
			cancel: () => cleanup(),
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			},
		});
	}

	private broadcast(space: string, event: string, data: unknown): void {
		for (const send of this.viewers.get(space) ?? []) send(event, data);
	}

	/** Number of open viewer streams for a space; used by tests and diagnostics. */
	viewerCount(space: string): number {
		return this.viewers.get(space)?.size ?? 0;
	}
}
