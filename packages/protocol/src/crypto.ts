/**
 * Credentials and end-to-end encryption, on WebCrypto so the same code runs in Node,
 * Cloudflare Workers and browsers.
 *
 * A space is shared by every machine and viewer that holds its view secret. From that secret
 * each side derives the space id, the token viewers present to the server, and the key that
 * seals every snapshot. Servers only ever see the id, hashes of the tokens, and ciphertext.
 * Machines additionally hold a publish secret, so viewers can read but never write.
 */

const SALT = new TextEncoder().encode("claude-lookout/v1");

export interface Sealed {
	iv: string;
	ct: string;
}

export interface SpaceKeys {
	spaceId: string;
	viewToken: string;
	key: CryptoKey;
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256 random bits, URL-safe. */
export function randomSecret(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isSecret(text: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(text);
}

async function hkdf(secret: string, label: string, bytes: number): Promise<Uint8Array> {
	const base = await crypto.subtle.importKey("raw", fromBase64Url(secret), "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(label) },
		base,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

/** The token a holder of `secret` presents for `purpose` ("view" or "publish"). */
export async function deriveToken(secret: string, purpose: string): Promise<string> {
	return toBase64Url(await hkdf(secret, `token:${purpose}`, 32));
}

export async function deriveSpace(viewSecret: string): Promise<SpaceKeys> {
	const [id, viewToken, raw] = await Promise.all([
		hkdf(viewSecret, "space-id", 16),
		deriveToken(viewSecret, "view"),
		hkdf(viewSecret, "seal", 32),
	]);
	const key = await crypto.subtle.importKey(
		"raw",
		raw as Uint8Array<ArrayBuffer>,
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);
	return { spaceId: toHex(id), viewToken, key };
}

/** What a server stores to check a token without being able to present it. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return toHex(new Uint8Array(digest));
}

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = new TextEncoder().encode(JSON.stringify(value));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
	return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

export async function open<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64Url(sealed.iv) },
		key,
		fromBase64Url(sealed.ct),
	);
	return JSON.parse(new TextDecoder().decode(plain)) as T;
}
