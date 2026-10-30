import type { SessionState, SessionView } from "@claude-lookout/protocol";
import { describe, expect, it } from "vitest";
import {
	activityDigest,
	conversationDigest,
	detailsDigest,
	filesDigest,
	gitAlerts,
	gitDigest,
	modelName,
	runFailed,
	stateLabel,
	urgency,
} from "./session-format.ts";

const NOW = 1_000_000;

function session(state: SessionState, fields: Record<string, unknown> = {}): SessionView {
	return { id: "s", state, since: NOW - 120_000, startedAt: 0, updatedAt: NOW, fields };
}

const texts = (parts: { text: string }[] | undefined) => parts?.map((p) => p.text);

describe("failed runs", () => {
	it("shows a run that ended in an error as failed, not finished", () => {
		const failed = session("finished", { error: "API error" });
		expect(runFailed(failed)).toBe(true);
		expect(stateLabel(failed)).toBe("Run failed");
		expect(stateLabel(session("finished"))).toBe("Finished");
	});

	it("sorts a failed run after whatever needs you and before running sessions", () => {
		const failed = urgency(session("finished", { error: "API error" }));
		expect(failed).toBeGreaterThan(urgency(session("plan")));
		expect(failed).toBeLessThan(urgency(session("working")));
	});
});

describe("gitAlerts", () => {
	it("names a stopped rebase and files in conflict", () => {
		const s = session("finished", {
			git: { commits: 0, earlier: 0, busy: { kind: "rebase", step: 2, total: 5 } },
			changes: {
				files: [
					{ path: "a.ts", added: 1, removed: 0, status: "conflict" },
					{ path: "b.ts", added: 1, removed: 0, status: "changed" },
				],
				total: 2,
				added: 2,
				removed: 0,
			},
		});
		expect(gitAlerts(s)).toEqual(["Rebase stopped at 2 of 5", "1 file in conflict"]);
	});

	it("is empty for a clean repository", () => {
		expect(gitAlerts(session("finished", { git: { commits: 1, earlier: 0 } }))).toEqual([]);
	});
});

describe("digests", () => {
	it("leaves out sections with nothing in them", () => {
		const s = session("ready");
		expect(conversationDigest(s, NOW)).toBeUndefined();
		expect(activityDigest(s, NOW)).toBeUndefined();
		expect(filesDigest(s)).toBeUndefined();
		expect(gitDigest(s)).toBeUndefined();
	});

	it("dates a finished reply", () => {
		expect(texts(conversationDigest(session("finished", { lastMessage: "Done" }), NOW))).toEqual([
			"Reply 2m ago",
		]);
	});

	it("sums up activity with the running step, tasks and failures", () => {
		const s = session("working", {
			tasks: { total: 8, done: 5 },
			steps: [
				{ tool: "Bash", at: NOW - 5000, outcome: "failed" },
				{ tool: "Edit", at: NOW - 4000, outcome: "done" },
				{ tool: "Bash", at: NOW - 72_000 },
			],
		});
		const digest = activityDigest(s, NOW);
		expect(texts(digest)).toEqual(["Bash 1m", "5 of 8 tasks", "3 recent steps", "1 failed"]);
		expect(digest?.at(-1)?.tone).toBe("halt");
	});

	it("puts conflicts first among the files and glues the line counts", () => {
		const digest = filesDigest(
			session("finished", {
				changes: {
					files: [{ path: "a.ts", added: 3, removed: 1, status: "conflict" }],
					total: 6,
					added: 120,
					removed: 34,
				},
			}),
		);
		expect(texts(digest)).toEqual(["1 in conflict", "6 files changed", "+120", "−34"]);
		expect(digest?.[0]?.tone).toBe("lamp");
		expect(digest?.[2]?.glued).toBe(true);
	});

	it("calls out unpushed commits and falls back to where the branch stands", () => {
		expect(
			texts(gitDigest(session("finished", { git: { commits: 2, earlier: 0, unpushed: 2 } }))),
		).toEqual(["2 commits", "2 not pushed"]);
		const clean = session("finished", {
			git: { commits: 0, earlier: 0, upstream: { ref: "origin/main", ahead: 0, behind: 0 } },
		});
		expect(texts(gitDigest(clean))).toEqual(["Up to date"]);
	});

	it("names the model, mode and branch", () => {
		const s = session("working", { model: "claude-opus-5-5", mode: "auto", branch: "main" });
		expect(texts(detailsDigest(s))).toEqual(["Opus 5.5", "Auto", "main"]);
	});
});

describe("modelName", () => {
	it("shortens Claude model ids and keeps anything else as it is", () => {
		expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
		expect(modelName("claude-opus-4-20250514")).toBe("Opus 4");
		expect(modelName("claude-fable-5-1[1m]")).toBe("Fable 5.1");
		expect(modelName("gpt-x")).toBe("gpt-x");
		expect(modelName(undefined)).toBeUndefined();
	});
});
