import { describe, expect, it } from "vitest";
import { clip, redact } from "./redact.ts";

describe("redact", () => {
	it.each([
		["export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv", "export OPENAI_API_KEY=••••"],
		["curl -H 'Authorization: Bearer abc.def.ghi123'", "curl -H 'Authorization: Bearer ••••'"],
		["token ghp_abcdefghijklmnopqrstuvwxyz0123", "token ••••"],
		["postgres://admin:hunter2@db:5432/app", "postgres://admin:••••@db:5432/app"],
		['{"password": "hunter2"}', '{"password": ••••}'],
		["AKIAABCDEFGHIJKLMNOP is the key id", "•••• is the key id"],
		["mysql --password hunter2secret db", "mysql --password •••• db"],
		["deploy --token=abcdef123456 now", "deploy --token=•••• now"],
		["curl -u admin:hunter2 http://x", "curl -u admin:•••• http://x"],
		["https://s3/x?X-Amz-Signature=abc123&a=1", "https://s3/x?X-Amz-Signature=••••&a=1"],
		["https://maps.example/?key=AIzaabc", "https://maps.example/?key=••••"],
	])("masks %s", (input, expected) => {
		expect(redact(input)).toBe(expected);
	});

	it.each([
		"Run npm test and fix the failing assertion in parser.ts",
		"echo x | docker login --password-stdin",
		"npm test -- --pass-with-no-tests",
		"git push -u origin main",
		"ssh -p 2222 host && mkdir -p a/b",
	])("leaves ordinary text alone: %s", (text) => {
		expect(redact(text)).toBe(text);
	});

	it("clips long text", () => {
		expect(clip("abcdef", 4)).toBe("abc…");
		expect(clip("abc", 4)).toBe("abc");
	});
});
