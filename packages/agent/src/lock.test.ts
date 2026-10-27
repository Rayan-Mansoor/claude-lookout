import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isAgentProcess, lockHolder, releaseLock } from "./lock.ts";

const lockIn = () => join(mkdtempSync(join(tmpdir(), "lookout-lock-")), "agent.lock");

describe("agent lock", () => {
	it("is taken once, with the pid already written", () => {
		const path = lockIn();
		expect(acquireLock(path, () => true, 101)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("101");
		expect(acquireLock(path, () => true, 102)).toBe(false);
		expect(lockHolder(path)).toBe(101);
	});

	it("replaces a lock whose holder is gone", () => {
		const path = lockIn();
		writeFileSync(path, "101");
		expect(acquireLock(path, () => false, 102)).toBe(true);
		expect(lockHolder(path)).toBe(102);
	});

	it("never replaces a lock another agent took over in the meantime", () => {
		const path = lockIn();
		writeFileSync(path, "101");
		// 102 judges 101 gone, but 103 replaces the lock first.
		let first = true;
		const alive = (pid: number) => {
			if (pid === 101 && first) {
				first = false;
				expect(acquireLock(path, (p) => p !== 101, 103)).toBe(true);
				return false;
			}
			return pid === 103;
		};
		expect(acquireLock(path, alive, 102)).toBe(false);
		expect(lockHolder(path)).toBe(103);
	});

	it("treats a damaged lock as stale and leaves no temporary files", () => {
		const path = lockIn();
		writeFileSync(path, "");
		expect(acquireLock(path, () => true, 102)).toBe(true);
		expect(readdirSync(join(path, ".."))).toEqual(["agent.lock"]);
	});

	it("is only given back by its holder", () => {
		const path = lockIn();
		acquireLock(path, () => true, 101);
		releaseLock(path, 102);
		expect(lockHolder(path)).toBe(101);
		releaseLock(path, 101);
		expect(lockHolder(path)).toBeUndefined();
	});

	it("doesn't take another program for an agent", () => {
		expect(isAgentProcess(process.pid)).toBe(false);
		expect(isAgentProcess(2 ** 22 + 7)).toBe(false);
	});
});
