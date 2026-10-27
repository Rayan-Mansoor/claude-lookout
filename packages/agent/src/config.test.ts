import { describe, expect, it } from "vitest";
import { defaultConfig, joinCode, parseJoinCode, viewLink } from "./config.ts";
import { applyOptions } from "./setup.ts";

describe("config", () => {
	it("links to the local dashboard by default", () => {
		const config = defaultConfig();
		expect(viewLink(config)).toBe(`http://localhost:4777/#k=${config.space.view}`);
	});

	it("switches to a relay and links there", () => {
		const config = applyOptions(defaultConfig(), { yes: true, relay: "https://relay.example/" });
		expect(config.transport).toEqual({ mode: "relay", url: "https://relay.example" });
		expect(viewLink(config)).toBe(`https://relay.example/#k=${config.space.view}`);
	});

	it("round-trips a join code into the same space and relay", () => {
		const first = applyOptions(defaultConfig(), { yes: true, relay: "https://relay.example" });
		const code = joinCode(first) as string;
		expect(code).toMatch(/^cl1\./);
		const second = applyOptions(defaultConfig(), { yes: true, join: code });
		expect(second.space).toEqual(first.space);
		expect(second.transport).toEqual(first.transport);
		expect(second.machine.id).not.toBe(first.machine.id);
	});

	it("carries the relay's key in the join code and still reads codes without one", () => {
		const keyed = applyOptions(defaultConfig(), {
			yes: true,
			relay: "https://relay.example",
			relayKey: "owner-key",
		});
		expect(parseJoinCode(joinCode(keyed) ?? "")?.transport).toEqual({
			mode: "relay",
			url: "https://relay.example",
			key: "owner-key",
		});
		const plain = applyOptions(defaultConfig(), { yes: true, relay: "https://relay.example" });
		expect(parseJoinCode(joinCode(plain) ?? "")?.transport).toEqual({
			mode: "relay",
			url: "https://relay.example",
		});
		expect(applyOptions(plain, { yes: true, relayKey: "later" }).transport).toMatchObject({
			key: "later",
		});
	});

	it("has no join code in Direct mode and rejects bad codes", () => {
		expect(joinCode(defaultConfig())).toBeUndefined();
		expect(parseJoinCode("cl1.nonsense")).toBeUndefined();
		expect(() => applyOptions(defaultConfig(), { yes: true, join: "nope" })).toThrow();
	});

	it("tunes Direct mode without dropping other settings", () => {
		const config = applyOptions(defaultConfig(), { yes: true, host: "0.0.0.0", port: 5000 });
		expect(config.transport).toMatchObject({ mode: "direct", host: "0.0.0.0", port: 5000 });
	});
});
