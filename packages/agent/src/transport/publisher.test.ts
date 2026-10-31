import type { Snapshot } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import type { Hold } from "../hold.ts";
import { type Publisher, throttled } from "./publisher.ts";

function setup(fail = false) {
	let held = 0;
	let finish: (() => void) | undefined;
	const hold: Hold = {
		take: () => {
			held++;
			return () => {
				held--;
			};
		},
	};
	const publisher: Publisher = {
		publish: () =>
			new Promise<void>((resolve, reject) => {
				finish = () => (fail ? reject(new Error("offline")) : resolve());
			}),
		notify: async () => ({ devices: 0, delivered: 0, failures: [] }),
		stop: () => {},
	};
	const publish = throttled(publisher, 0, () => {}, hold);
	const settle = async () => {
		finish?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { publish, settle, held: () => held };
}

const snapshot = {} as Snapshot;

describe("throttled", () => {
	it("holds until a state change has gone out", async () => {
		const { publish, settle, held } = setup();
		publish(snapshot, "m", { hold: true });
		expect(held()).toBe(1);
		await settle();
		expect(held()).toBe(0);
	});

	it("lets go when the publish fails", async () => {
		const { publish, settle, held } = setup(true);
		publish(snapshot, "m", { hold: true });
		await settle();
		expect(held()).toBe(0);
	});

	it("does not hold for heartbeats", () => {
		const { publish, held } = setup();
		publish(snapshot, "m");
		expect(held()).toBe(0);
	});
});
