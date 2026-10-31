import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileHold } from "./hold.ts";

describe("fileHold", () => {
	const dir = mkdtempSync(join(tmpdir(), "lookout-hold-"));
	const path = join(dir, "hold");
	afterEach(() => rmSync(path, { force: true }));

	it("keeps the marker until every piece of work is done", () => {
		const hold = fileHold(path);
		expect(existsSync(path)).toBe(false);
		const first = hold.take();
		const second = hold.take();
		expect(existsSync(path)).toBe(true);
		first();
		expect(existsSync(path)).toBe(true);
		second();
		expect(existsSync(path)).toBe(false);
	});

	it("counts a release only once", () => {
		const hold = fileHold(path);
		const first = hold.take();
		const second = hold.take();
		first();
		first();
		expect(existsSync(path)).toBe(true);
		second();
		expect(existsSync(path)).toBe(false);
	});
});
