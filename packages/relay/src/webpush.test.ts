import { fromBase64Url, toBase64Url } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import {
	encryptPayload,
	generateVapidKeys,
	sendPush,
	UNUSABLE,
	vapidAuthorization,
} from "./webpush.ts";

type Bytes = Uint8Array<ArrayBuffer>;
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

const encoder = new TextEncoder();

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, new Uint8Array([...info, 1]))).slice(0, length);
}

/** What a browser does on receipt (RFC 8291), written independently of the sender. */
async function browserDecrypt(body: Bytes, uaKeys: KeyPair, auth: Bytes) {
	const salt = body.slice(0, 16);
	const idLength = body[20] ?? 0;
	const asPublic = body.slice(21, 21 + idLength);
	const ciphertext = body.slice(21 + idLength);
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey));
	const asKey = await crypto.subtle.importKey(
		"raw",
		asPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaKeys.privateKey, 256),
	);
	const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
	const ikm = await hkdf(auth, shared, info, 32);
	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext),
	);
	expect(plain.at(-1)).toBe(2);
	return new TextDecoder().decode(plain.slice(0, -1));
}

describe("web push", () => {
	it("encrypts payloads a browser can decrypt", async () => {
		const uaKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveBits",
		])) as KeyPair;
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const p256dh = toBase64Url(
			new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey)),
		);
		const subscription = {
			endpoint: "https://push.example/abc",
			keys: { p256dh, auth: toBase64Url(auth) },
		};
		const body = (await encryptPayload(subscription, encoder.encode('{"hello":"phone"}'))) as Bytes;
		expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
		expect(await browserDecrypt(body, uaKeys, auth)).toBe('{"hello":"phone"}');
	});

	it("signs VAPID tokens the push service can verify", async () => {
		const keys = await generateVapidKeys();
		const header = await vapidAuthorization("https://push.example/abc", keys, "mailto:a@b.c");
		const [, token, k] = header.match(/^vapid t=(\S+), k=(\S+)$/) ?? [];
		expect(k).toBe(keys.publicKey);
		const [h, c, sig] = (token ?? "").split(".");
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c ?? "")));
		expect(claims).toMatchObject({ aud: "https://push.example", sub: "mailto:a@b.c" });
		const publicKey = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(keys.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			publicKey,
			fromBase64Url(sig ?? ""),
			encoder.encode(`${h}.${c}`),
		);
		expect(valid).toBe(true);
	});

	it("gives up on a subscription whose keys can't be used, without sending anything", async () => {
		const keys = await generateVapidKeys();
		const status = await sendPush(
			{ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "bad", auth: "bad" } },
			"{}",
			keys,
			"mailto:a@b.c",
		);
		expect(status).toBe(UNUSABLE);
	});
});
