import type { HookInput, Notice } from "@claude-lookout/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.ts";
import { defaultConfig } from "./config.ts";
import { describeDelivery, NOTIFY_DELAY_MS, RETRY_MS, startNotifier } from "./notifier.ts";
import type { Publisher } from "./transport/publisher.ts";

function setup(lid = false, failures = 0) {
	const agent = new Agent(
		{ ...defaultConfig(), machine: { id: "m", name: "Studio" } },
		{ gitBranch: () => undefined },
	);
	const sent: Notice[] = [];
	const publisher: Publisher = {
		publish: async () => {},
		notify: async (notice) => {
			if (failures-- > 0) throw new Error("fetch failed");
			sent.push(notice);
			return { devices: 1, delivered: 1, failures: [] };
		},
		stop: () => {},
	};
	startNotifier(agent, publisher, () => {}, { lidClosed: async () => lid });
	const send = (input: Partial<HookInput>) =>
		agent.handle({
			input: { session_id: "s1", cwd: "/w/api", ...input } as HookInput,
			at: Date.now(),
		});
	return { sent, send };
}

const permission = {
	hook_event_name: "PermissionRequest",
	tool_name: "Bash",
	tool_input: { command: "npm publish" },
};

describe("notifier", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("notifies once a session has waited for you", async () => {
		const { sent, send } = setup();
		send(permission);
		await vi.advanceTimersByTimeAsync(NOTIFY_DELAY_MS - 1);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toEqual([
			{ title: "api needs permission", body: "Bash · npm publish · Studio", tag: "s1" },
		]);
	});

	it("tries again when a notification couldn't go out", async () => {
		const { sent, send } = setup(false, 2);
		send(permission);
		await vi.advanceTimersByTimeAsync(NOTIFY_DELAY_MS + (RETRY_MS[0] ?? 0) - 1);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1 + (RETRY_MS[1] ?? 0));
		expect(sent).toHaveLength(1);
	});

	it("stops trying once the session no longer needs you", async () => {
		const { sent, send } = setup(false, 1);
		send(permission);
		await vi.advanceTimersByTimeAsync(NOTIFY_DELAY_MS);
		send({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "npm publish" },
		});
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toEqual([]);
	});

	it("stays quiet when the prompt is answered at the keyboard", async () => {
		const { sent, send } = setup();
		send(permission);
		await vi.advanceTimersByTimeAsync(2000);
		send({ hook_event_name: "PostToolUse", tool_name: "Bash" });
		await vi.advanceTimersByTimeAsync(NOTIFY_DELAY_MS * 2);
		expect(sent).toEqual([]);
	});

	it("notifies at once when the lid is closed", async () => {
		const { sent, send } = setup(true);
		send(permission);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
	});

	it("logs what happened to each notification", () => {
		const notice = { title: "api finished", body: "", tag: "s1" };
		expect(describeDelivery(notice, { devices: 0, delivered: 0, failures: [] })).toBe(
			"no devices have notifications on: api finished",
		);
		expect(describeDelivery(notice, { devices: 2, delivered: 1, failures: [403] })).toBe(
			"notified 1/2 devices: api finished (push service answered 403)",
		);
	});

	it("does not notify while Claude is working", async () => {
		const { sent, send } = setup();
		send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
		await vi.advanceTimersByTimeAsync(NOTIFY_DELAY_MS * 2);
		expect(sent).toEqual([]);
	});
});
