import {
	API,
	deriveSpace,
	deriveToken,
	hashToken,
	type MachineUpdate,
	randomSecret,
} from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import { Hub, type HubOptions, MAX_BODY } from "./hub.ts";
import { MemoryStore } from "./store.ts";

const BASE = "http://hub.test";
const sealed = { iv: "aaaa", ct: "bbbb" };

async function setup(options = {}) {
	const hub = new Hub(new MemoryStore(), options);
	const viewSecret = randomSecret();
	const publishSecret = randomSecret();
	const { spaceId, viewToken } = await deriveSpace(viewSecret);
	const publishToken = await deriveToken(publishSecret, "publish");
	const registration = {
		viewHash: await hashToken(viewToken),
		publishHash: await hashToken(publishToken),
	};
	const call = (path: string, init: RequestInit & { token?: string } = {}) => {
		const headers = new Headers(init.headers);
		if (init.token) headers.set("authorization", `Bearer ${init.token}`);
		return hub.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
	};
	const register = () =>
		call(API.space(spaceId), { method: "PUT", body: JSON.stringify(registration) });
	const publish = (machine: string, token = publishToken) =>
		call(API.machine(spaceId, machine), { method: "PUT", body: JSON.stringify(sealed), token });
	const registerWith = (relayKey?: string) =>
		call(API.space(spaceId), {
			method: "PUT",
			body: JSON.stringify({ ...registration, ...(relayKey ? { relayKey } : {}) }),
		});
	return { hub, spaceId, viewToken, publishToken, call, register, registerWith, publish };
}

async function readEvents(response: Response, count: number) {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const events: { event: string; data: unknown }[] = [];
	let buffer = "";
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value);
		let end = buffer.indexOf("\n\n");
		while (end >= 0) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			end = buffer.indexOf("\n\n");
			const event = block.match(/^event: (.+)$/m)?.[1];
			const data = block.match(/^data: (.+)$/m)?.[1];
			if (event && data) events.push({ event, data: JSON.parse(data) });
		}
	}
	return { events, reader };
}

describe("Hub", () => {
	it("registers a space once and refuses different credentials", async () => {
		const { register, call, spaceId } = await setup();
		expect((await register()).status).toBe(201);
		expect((await register()).status).toBe(200);
		const other = { viewHash: "0".repeat(64), publishHash: "1".repeat(64) };
		const res = await call(API.space(spaceId), { method: "PUT", body: JSON.stringify(other) });
		expect(res.status).toBe(409);
	});

	it("only accepts snapshots from machines holding the publish secret", async () => {
		const { register, publish, viewToken } = await setup();
		await register();
		expect((await publish("mac", viewToken)).status).toBe(401);
		expect((await publish("mac", "nonsense")).status).toBe(401);
		expect((await publish("mac")).status).toBe(200);
	});

	it("streams stored and new snapshots to viewers holding the view token", async () => {
		const { hub, register, publish, call, spaceId, viewToken, publishToken } = await setup();
		await register();
		await publish("mac");

		expect((await call(API.events(spaceId), { token: publishToken })).status).toBe(401);
		const res = await call(API.events(spaceId), { token: viewToken });
		expect(res.headers.get("content-type")).toBe("text/event-stream");

		const first = await readEvents(res, 2);
		expect(first.events.map((e) => e.event)).toEqual(["machine", "ready"]);
		expect(first.events[0]?.data).toMatchObject({ sealed } satisfies Partial<MachineUpdate>);
		expect(hub.viewerCount(spaceId)).toBe(1);

		await publish("studio");
		const reader = first.reader;
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toContain('"machine":"studio"');
		await reader.cancel();
		expect(hub.viewerCount(spaceId)).toBe(0);
	});

	it("ends viewer streams after the configured time", async () => {
		const { hub, register, call, spaceId, viewToken } = await setup({ maxStreamMs: 50 });
		await register();
		const res = await call(API.events(spaceId), { token: viewToken });
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let done = false;
		while (!done) done = (await reader.read()).done;
		expect(hub.viewerCount(spaceId)).toBe(0);
	});

	it("hands out a push key, stores subscriptions and forwards sealed notifications", async () => {
		const sent: { endpoint: string; payload: string }[] = [];
		const { register, call, spaceId, viewToken, publishToken } = await setup({
			sendPush: async (sub: { endpoint: string }, payload: string) => {
				sent.push({ endpoint: sub.endpoint, payload });
				return sub.endpoint.endsWith("gone") ? 410 : 201;
			},
		});
		await register();
		const key = await call(`${API.space(spaceId)}/push/key`, { token: viewToken });
		expect(((await key.json()) as { publicKey: string }).publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

		const subscribe = (endpoint: string, id: string) =>
			call(`${API.space(spaceId)}/push/subscriptions/${id.repeat(64)}`, {
				method: "PUT",
				token: viewToken,
				body: JSON.stringify({ endpoint, keys: { p256dh: "x", auth: "y" } }),
			});
		expect((await subscribe("https://fcm.googleapis.com/fcm/send/phone", "a")).status).toBe(200);
		expect((await subscribe("https://fcm.googleapis.com/fcm/send/gone", "b")).status).toBe(200);

		const notify = () =>
			call(`${API.space(spaceId)}/push/notify`, {
				method: "POST",
				token: publishToken,
				body: JSON.stringify(sealed),
			});
		expect(await (await notify()).json()).toEqual({ devices: 2, delivered: 1, failures: [410] });
		expect(JSON.parse(sent[0]?.payload ?? "")).toEqual({ sealed });
		sent.length = 0;
		await notify();
		expect(sent.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/phone"]);

		const asViewer = await call(`${API.space(spaceId)}/push/notify`, {
			method: "POST",
			token: viewToken,
			body: JSON.stringify(sealed),
		});
		expect(asViewer.status).toBe(401);
	});

	it("only sends to browser push services", async () => {
		const { register, call, spaceId, viewToken } = await setup();
		await register();
		const subscribe = (endpoint: string) =>
			call(`${API.space(spaceId)}/push/subscriptions/${"c".repeat(64)}`, {
				method: "PUT",
				token: viewToken,
				body: JSON.stringify({ endpoint, keys: { p256dh: "x", auth: "y" } }),
			});
		for (const endpoint of [
			"https://127.0.0.1/hook",
			"https://intranet.local/admin",
			"https://fcm.googleapis.com.evil.test/x",
			"https://fcm.googleapis.com:8443/x",
			"http://fcm.googleapis.com/x",
		]) {
			expect((await subscribe(endpoint)).status, endpoint).toBe(400);
		}
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/x",
			"https://updates.push.services.mozilla.com/wpush/v2/x",
			"https://web.push.apple.com/x",
			"https://wns2-par02p.notify.windows.com/w/?token=x",
		]) {
			expect((await subscribe(endpoint)).status, endpoint).toBe(200);
		}
	});

	it("makes room for a new device by dropping the longest-standing subscription", async () => {
		const sent: string[] = [];
		const { register, call, spaceId, viewToken, publishToken } = await setup({
			sendPush: async (sub: { endpoint: string }) => {
				sent.push(sub.endpoint);
				return 201;
			},
		});
		await register();
		for (let i = 0; i <= 20; i++) {
			const id = i.toString(16).padStart(64, "0");
			const res = await call(`${API.space(spaceId)}/push/subscriptions/${id}`, {
				method: "PUT",
				token: viewToken,
				body: JSON.stringify({
					endpoint: `https://fcm.googleapis.com/fcm/send/${i}`,
					keys: { p256dh: "x", auth: "y" },
				}),
			});
			expect(res.status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		await call(`${API.space(spaceId)}/push/notify`, {
			method: "POST",
			token: publishToken,
			body: JSON.stringify(sealed),
		});
		expect(sent).toHaveLength(20);
		expect(sent).not.toContain("https://fcm.googleapis.com/fcm/send/0");
		expect(sent).toContain("https://fcm.googleapis.com/fcm/send/20");
	});

	it("rejects unknown routes and malformed bodies", async () => {
		const { call, register, spaceId, publishToken } = await setup();
		expect((await call("/api/spaces/nothex")).status).toBe(404);
		await register();
		const bad = await call(API.machine(spaceId, "mac"), {
			method: "PUT",
			body: "{}",
			token: publishToken,
		});
		expect(bad.status).toBe(400);
	});

	it("only creates spaces for whoever holds the relay's key, when it has one", async () => {
		const { registerWith, publish } = await setup({ relayKey: "owner-key" });
		expect((await registerWith()).status).toBe(403);
		expect((await registerWith("wrong")).status).toBe(403);
		expect((await publish("mac")).status).toBe(401);
		expect((await registerWith("owner-key")).status).toBe(201);
		expect((await publish("mac")).status).toBe(200);
	});

	it("refuses a body that says it is over the limit without reading it", async () => {
		const { call, register, spaceId, publishToken } = await setup();
		await register();
		const res = await call(API.machine(spaceId, "mac"), {
			method: "PUT",
			body: JSON.stringify(sealed),
			headers: { "content-length": String(MAX_BODY + 1) },
			token: publishToken,
		});
		expect(res.status).toBe(400);
	});
});
