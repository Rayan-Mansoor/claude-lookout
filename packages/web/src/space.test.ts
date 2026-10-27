import type { Snapshot } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import { parseViewSecret, supersedes } from "./space.ts";

const snapshot = (machine: string, sentAt: number): Snapshot => ({
	v: 1,
	machine: { id: machine, name: "Mac" },
	sentAt,
	sessions: [],
});

describe("supersedes", () => {
	it("takes a newer snapshot and the first one", () => {
		expect(supersedes(snapshot("m1", 2), "m1", { snapshot: snapshot("m1", 1) })).toBe(true);
		expect(supersedes(snapshot("m1", 1), "m1", undefined)).toBe(true);
	});

	it("never turns the view back to an older snapshot", () => {
		expect(supersedes(snapshot("m1", 1), "m1", { snapshot: snapshot("m1", 2) })).toBe(false);
	});

	it("refuses a snapshot filed under another machine", () => {
		expect(supersedes(snapshot("m2", 5), "m1", undefined)).toBe(false);
	});
});

describe("parseViewSecret", () => {
	it("reads a secret from a link or on its own", () => {
		const secret = "a".repeat(43);
		expect(parseViewSecret(`https://x.test/#k=${secret}`)).toBe(secret);
		expect(parseViewSecret(` ${secret} `)).toBe(secret);
		expect(parseViewSecret("nope")).toBeUndefined();
	});
});
