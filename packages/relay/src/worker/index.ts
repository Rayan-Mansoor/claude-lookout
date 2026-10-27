import { DurableObject } from "cloudflare:workers";
import { Hub } from "../hub.ts";
import type { HubStore } from "../store.ts";

interface Env {
	SPACES: DurableObjectNamespace<Space>;
	ASSETS: Fetcher;
	/** Set with `wrangler secret put RELAY_KEY` to decide who may create spaces here. */
	RELAY_KEY?: string;
}

const SPACE_ROUTE = /^\/api\/spaces\/([0-9a-f]{32})(\/|$)/;

/** Keep phone dashboards from holding a Durable Object open for hours. */
const MAX_STREAM_MS = 15 * 60_000;

class DurableStore implements HubStore {
	private readonly storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.storage = storage;
	}

	get<T>(key: string): Promise<T | undefined> {
		return this.storage.get<T>(key);
	}

	put(key: string, value: unknown): Promise<void> {
		return this.storage.put(key, value);
	}

	async delete(key: string): Promise<void> {
		await this.storage.delete(key);
	}

	list<T>(prefix: string): Promise<Map<string, T>> {
		return this.storage.list<T>({ prefix });
	}
}

/** One Durable Object per space: its registration, machines and live viewers. */
export class Space extends DurableObject<Env> {
	private readonly hub: Hub;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.hub = new Hub(new DurableStore(ctx.storage), {
			maxStreamMs: MAX_STREAM_MS,
			...(env.RELAY_KEY ? { relayKey: env.RELAY_KEY } : {}),
		});
	}

	override fetch(request: Request): Promise<Response> {
		return this.hub.fetch(request);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const space = url.pathname.match(SPACE_ROUTE)?.[1];
		if (space) return env.SPACES.get(env.SPACES.idFromName(space)).fetch(request);
		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
