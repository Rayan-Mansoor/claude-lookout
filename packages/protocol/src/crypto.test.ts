import { describe, expect, it } from "vitest";
import {
	deriveSpace,
	deriveToken,
	fromBase64Url,
	hashToken,
	isSecret,
	open,
	randomSecret,
	seal,
	toBase64Url,
} from "./crypto.ts";

describe("crypto", () => {
	it("makes 256-bit URL-safe secrets", () => {
		const secret = randomSecret();
		expect(isSecret(secret)).toBe(true);
		expect(fromBase64Url(secret)).toHaveLength(32);
		expect(toBase64Url(fromBase64Url(secret))).toBe(secret);
	});

	it("derives the same space from the same secret, and different ones otherwise", async () => {
		const secret = randomSecret();
		const a = await deriveSpace(secret);
		const b = await deriveSpace(secret);
		const other = await deriveSpace(randomSecret());
		expect(a.spaceId).toMatch(/^[0-9a-f]{32}$/);
		expect(a.spaceId).toBe(b.spaceId);
		expect(a.viewToken).toBe(b.viewToken);
		expect(other.spaceId).not.toBe(a.spaceId);
		expect(await deriveToken(secret, "publish")).not.toBe(a.viewToken);
	});

	it("seals so only holders of the secret can read", async () => {
		const secret = randomSecret();
		const { key } = await deriveSpace(secret);
		const sealed = await seal(key, { state: "working" });
		expect(sealed.ct).not.toContain("working");
		expect(await open(key, sealed)).toEqual({ state: "working" });
		const { key: wrong } = await deriveSpace(randomSecret());
		await expect(open(wrong, sealed)).rejects.toThrow();
	});

	it("hashes tokens to hex", async () => {
		expect(await hashToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});
