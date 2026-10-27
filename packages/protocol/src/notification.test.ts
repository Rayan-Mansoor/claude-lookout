import { describe, expect, it } from "vitest";
import { noticeFor } from "./notification.ts";
import type { SessionView } from "./snapshot.ts";

const view = (state: SessionView["state"], fields: Record<string, unknown>): SessionView => ({
	id: "s1",
	state,
	since: 0,
	startedAt: 0,
	updatedAt: 0,
	fields: { project: "api", ...fields },
});

describe("noticeFor", () => {
	it("describes what each blocked state needs", () => {
		expect(
			noticeFor(
				view("permission", { permission: { tool: "Bash", target: "npm test", suggestions: [] } }),
				"Mac",
			),
		).toEqual({ title: "api needs permission", body: "Bash · npm test · Mac", tag: "s1" });
		expect(
			noticeFor(
				view("question", {
					questions: [{ question: "Which DB?", options: [], multiSelect: false }],
				}),
				"Mac",
			)?.body,
		).toBe("Which DB? · Mac");
		expect(noticeFor(view("plan", { plan: "\n# Ship it\nmore" }), "Mac")?.body).toBe(
			"Ship it · more · Mac",
		);
	});

	it("summarises a finished run with Claude's first line", () => {
		const notice = noticeFor(
			view("finished", { lastMessage: "**All tests pass.**\nDetails…" }),
			"Mac",
		);
		expect(notice).toMatchObject({ title: "api finished", body: "All tests pass. · Mac" });
	});

	it("names the session by its conversation title when there is one", () => {
		const notice = noticeFor(view("finished", { title: "Fix login redirect" }), "Mac");
		expect(notice?.title).toBe("Fix login redirect finished");
	});

	it("stays generic when content isn't shared", () => {
		expect(noticeFor(view("question", {}), "Mac")?.body).toBe("Open Lookout to see more · Mac");
	});

	it("does not notify for running or closed sessions", () => {
		expect(noticeFor(view("working", {}), "Mac")).toBeUndefined();
		expect(noticeFor(view("gone", {}), "Mac")).toBeUndefined();
	});
});
