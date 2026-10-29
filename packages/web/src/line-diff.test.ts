import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff.ts";

describe("lineDiff", () => {
	it("keeps shared lines and marks the ones that change", () => {
		expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "removed", text: "b" },
			{ kind: "added", text: "B" },
			{ kind: "same", text: "c" },
			{ kind: "added", text: "d" },
		]);
	});

	it("shows a deletion and an insertion in full", () => {
		expect(lineDiff("gone", "")).toEqual([{ kind: "removed", text: "gone" }]);
		expect(lineDiff("", "new")).toEqual([{ kind: "added", text: "new" }]);
	});
});
