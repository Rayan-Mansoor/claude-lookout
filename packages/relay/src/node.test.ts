import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hub, MAX_BODY } from "./hub.ts";
import { createHubServer } from "./node.ts";
import { MemoryStore } from "./store.ts";

let server: Server | undefined;

afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

async function start(): Promise<number> {
	const webRoot = mkdtempSync(join(tmpdir(), "lookout-web-"));
	writeFileSync(join(webRoot, "index.html"), "<p>dashboard</p>");
	server = createHubServer({ hub: new Hub(new MemoryStore()), webRoot });
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

/**
 * Send a request as it is, so malformed paths reach the server unchanged. Resolves with the
 * status, or 0 when the server cut the connection before answering.
 */
function raw(
	port: number,
	path: string,
	method = "GET",
	body?: Buffer,
	headers: Record<string, string> = {},
): Promise<number> {
	return new Promise((resolve) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.end(body);
	});
}

describe("hub server", () => {
	it("answers a malformed path and keeps serving", async () => {
		const port = await start();
		expect(await raw(port, "/%E0%A4%A")).toBe(400);
		expect(await raw(port, "/")).toBe(200);
	});

	it("refuses a body over the limit, declared or streamed, and keeps serving", async () => {
		const port = await start();
		const space = `/api/spaces/${"a".repeat(32)}`;
		const declared = { "content-length": String(MAX_BODY + 1) };
		expect(await raw(port, space, "PUT", Buffer.alloc(0), declared)).toBe(413);
		const chunked = { "transfer-encoding": "chunked" };
		expect([0, 413]).toContain(
			await raw(port, space, "PUT", Buffer.alloc(MAX_BODY + 1, 32), chunked),
		);
		expect(await raw(port, "/")).toBe(200);
	});
});
