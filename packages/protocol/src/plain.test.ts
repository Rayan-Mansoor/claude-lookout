import { describe, expect, it } from "vitest";
import { plainLine } from "./plain.ts";

describe("plainLine", () => {
	it.each([
		["## Summary\n\nFixed the **redirect**\nmore", "Summary · Fixed the redirect"],
		["# Plan", "Plan"],
		["**Done.** All `npm test` checks pass", "Done. All npm test checks pass"],
		["- [x] Wrote the *parser*", "☑ Wrote the parser"],
		["1. See [the docs](https://example.com/docs)", "See the docs"],
		["> ~~Old~~ new plan", "Old new plan"],
		["| File | Lines |\n|---|---:|\n| a.ts | 3 |", "File · Lines"],
		["```ts\nconst x = 1;\n```", "const x = 1;"],
		["\n---\n\nFixed issue #12 in snake_case_name", "Fixed issue #12 in snake_case_name"],
		["Use \\*literal\\* stars", "Use *literal* stars"],
	])("reads %j as %j", (markdown, expected) => {
		expect(plainLine(markdown)).toBe(expected);
	});

	it("has nothing to say for empty text", () => {
		expect(plainLine("")).toBeUndefined();
		expect(plainLine(undefined)).toBeUndefined();
	});
});
