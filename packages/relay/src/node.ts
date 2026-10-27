import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { type Hub, MAX_BODY } from "./hub.ts";
import { MemoryStore } from "./store.ts";

/** A store persisted as one JSON file; enough for one person's spaces. */
export class FileStore extends MemoryStore {
	private readonly path: string;

	constructor(path: string) {
		super();
		this.path = path;
		try {
			const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			for (const [key, value] of Object.entries(saved)) this.data.set(key, value);
		} catch {}
	}

	override async put(key: string, value: unknown): Promise<void> {
		await super.put(key, value);
		this.save();
	}

	override async delete(key: string): Promise<void> {
		await super.delete(key);
		this.save();
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)), { mode: 0o600 });
		renameSync(tmp, this.path);
	}
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
};

function serveStatic(webRoot: string, pathname: string, res: ServerResponse): void {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		res.writeHead(400, SECURITY_HEADERS).end("Bad request");
		return;
	}
	const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
	let file = join(webRoot, relative);
	if (!file.startsWith(webRoot + sep) && file !== webRoot) file = webRoot;
	try {
		if (statSync(file).isDirectory()) file = join(file, "index.html");
	} catch {
		file = join(webRoot, "index.html");
	}
	try {
		const body = readFileSync(file);
		const hashed = file.includes(`${sep}assets${sep}`);
		res.writeHead(200, {
			...SECURITY_HEADERS,
			"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
			"cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
		});
		res.end(body);
	} catch {
		res.writeHead(404, SECURITY_HEADERS).end("Not found");
	}
}

/** A request body over the limit, refused before it is read in full. */
class TooLarge extends Error {}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
	const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") headers.set(key, value);
	}
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	let body: Buffer | undefined;
	if (hasBody) {
		if (Number(req.headers["content-length"]) > MAX_BODY) throw new TooLarge();
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY) throw new TooLarge();
			chunks.push(chunk as Buffer);
		}
		body = Buffer.concat(chunks);
	}
	return new Request(url, {
		method: req.method ?? "GET",
		headers,
		signal,
		...(body ? { body } : {}),
	});
}

async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
	res.writeHead(response.status, { ...SECURITY_HEADERS, ...Object.fromEntries(response.headers) });
	if (!response.body) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	res.on("close", () => void reader.cancel().catch(() => {}));
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		res.write(value);
	}
	res.end();
}

export interface ServeOptions {
	hub: Hub;
	/** Folder holding the built dashboard. */
	webRoot: string;
}

/** An HTTP server for a hub plus the dashboard's static files. */
export function createHubServer({ hub, webRoot }: ServeOptions): Server {
	const fail = (res: ServerResponse, status: number) => {
		if (!res.headersSent) res.writeHead(status, SECURITY_HEADERS).end();
		else res.end();
	};
	return createServer((req, res) => {
		// Whatever a request contains, it must never take the server down.
		try {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (!pathname.startsWith("/api/")) {
				serveStatic(webRoot, pathname, res);
				return;
			}
			const abort = new AbortController();
			res.on("close", () => abort.abort());
			toRequest(req, abort.signal)
				.then((request) => hub.fetch(request))
				.then((response) => sendResponse(response, res))
				.catch((err) => {
					fail(res, err instanceof TooLarge ? 413 : 500);
					if (err instanceof TooLarge) req.destroy();
				});
		} catch {
			fail(res, 400);
		}
	});
}
