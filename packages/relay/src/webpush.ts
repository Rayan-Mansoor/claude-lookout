import { fromBase64Url, toBase64Url } from "@claude-lookout/protocol";

/**
 * Web Push on WebCrypto alone, so it runs in Workers and Node without a dependency:
 * VAPID (RFC 8292) to identify the sender and aes128gcm (RFC 8291) to encrypt the payload
 * for the browser that subscribed.
 */

export interface VapidKeys {
	/** Uncompressed P-256 public key, base64url; what browsers subscribe with. */
	publicKey: string;
	privateJwk: Jwk;
}

export interface PushSubscriptionJSON {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** Spelled out because Node's and Workers' type libraries name these differently. */
type Jwk = Record<string, unknown>;
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
const importJwk = crypto.subtle.importKey.bind(crypto.subtle) as unknown as (
	format: "jwk",
	keyData: Jwk,
	algorithm: { name: "ECDSA"; namedCurve: "P-256" },
	extractable: false,
	keyUsages: ["sign"],
) => Promise<CryptoKey>;

const exportRaw = async (key: CryptoKey) =>
	new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
const exportJwk = async (key: CryptoKey) =>
	(await crypto.subtle.exportKey("jwk", key)) as unknown as Jwk;

/** Workers' types spell the ECDH `public` member differently; the runtime wants `public`. */
const ecdh = (publicKey: CryptoKey) =>
	({ name: "ECDH", public: publicKey }) as unknown as Parameters<
		typeof crypto.subtle.deriveBits
	>[0];

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey(
		"raw",
		key as Uint8Array<ArrayBuffer>,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}

/** HKDF with a single output block, as RFC 8291 uses it. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as unknown as KeyPair;
	const raw = await exportRaw(pair.publicKey);
	const privateJwk = await exportJwk(pair.privateKey);
	return { publicKey: toBase64Url(raw), privateJwk };
}

/** A signed VAPID JWT for the push service at `endpoint`. */
export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	subject: string,
): Promise<string> {
	const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = {
		aud: new URL(endpoint).origin,
		exp: Math.floor(Date.now() / 1000) + 12 * 3600,
		sub: subject,
	};
	const body = toBase64Url(encoder.encode(JSON.stringify(claims)));
	const key = await importJwk(
		"jwk",
		keys.privateJwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		encoder.encode(`${header}.${body}`),
	);
	return `vapid t=${header}.${body}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/** Encrypt `payload` for one subscription (RFC 8291, a single aes128gcm record). */
export async function encryptPayload(
	subscription: PushSubscriptionJSON,
	payload: Uint8Array,
): Promise<Uint8Array> {
	const uaPublic = fromBase64Url(subscription.keys.p256dh);
	const authSecret = fromBase64Url(subscription.keys.auth);
	const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as unknown as KeyPair;
	const asPublic = await exportRaw(ephemeral.publicKey);
	const uaKey = await crypto.subtle.importKey(
		"raw",
		uaPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(ecdh(uaKey), ephemeral.privateKey, 256),
	);

	const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, shared, keyInfo, 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

	const aes = await crypto.subtle.importKey(
		"raw",
		cek as Uint8Array<ArrayBuffer>,
		"AES-GCM",
		false,
		["encrypt"],
	);
	const record = concat(payload, new Uint8Array([2]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
			aes,
			record,
		),
	);

	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = asPublic.length;
	return concat(header, asPublic, ciphertext);
}

/**
 * Deliver one push. Resolves with the push service's status; 404 and 410 mean the
 * subscription is gone and should be forgotten.
 */
/** The push services browsers subscribe through. The relay sends to these and nowhere else. */
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet, Opera, Brave
	/^android\.googleapis\.com$/, // older Chrome subscriptions
	/^updates\.push\.services\.mozilla\.com$/, // Firefox
	/(^|\.)push\.apple\.com$/, // Safari
	/(^|\.)notify\.windows\.com$/, // Edge on Windows
];

/**
 * Whether an endpoint belongs to a browser push service. Anything else would let whoever holds a
 * view link make the relay send requests wherever they like.
 */
export function isPushService(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname))
	);
}

/** What `sendPush` answers for a subscription whose keys can't be used, so it is dropped. */
export const UNUSABLE = 410;

export async function sendPush(
	subscription: PushSubscriptionJSON,
	payload: string,
	keys: VapidKeys,
	subject: string,
): Promise<number> {
	let body: Uint8Array;
	try {
		body = await encryptPayload(subscription, encoder.encode(payload));
	} catch {
		return UNUSABLE;
	}
	const res = await fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: "3600",
			urgency: "high",
		},
		body: body as Uint8Array<ArrayBuffer>,
		// A push service answers directly; following redirects could lead anywhere.
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	return res.status;
}
