import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS } from "@claude-lookout/protocol";
import { describe, expect, it, vi } from "vitest";
import { lineDiff, type Settings, withLookoutHooks, withoutLookoutHooks } from "./settings.ts";
import { nodeOnPath, writeSettings } from "./setup.ts";

const NODE = "/opt/homebrew/bin/node";
const SCRIPT = "/Users/me/.claude-lookout/app/claude-lookout.js";

const existing: Settings = {
	model: "opus",
	hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
};

describe("hook settings", () => {
	it("subscribes to every event without touching other hooks", () => {
		const next = withLookoutHooks(existing, NODE, SCRIPT);
		expect(Object.keys(next.hooks ?? {}).sort()).toEqual([...HOOK_EVENTS].sort());
		expect(next.hooks?.Stop?.[0]).toEqual(existing.hooks?.Stop?.[0]);
		expect(next.hooks?.PreToolUse?.[0]?.hooks?.[0]).toEqual({
			type: "command",
			command: NODE,
			args: [SCRIPT, "hook"],
			async: true,
			timeout: 10,
		});
		expect(next.model).toBe("opus");
	});

	it("is idempotent and replaces hooks installed from another path", () => {
		const once = withLookoutHooks(existing, NODE, "/old/claude-lookout/dist/claude-lookout.js");
		const twice = withLookoutHooks(once, NODE, SCRIPT);
		expect(twice).toEqual(withLookoutHooks(existing, NODE, SCRIPT));
	});

	it("removes exactly what it added", () => {
		expect(withoutLookoutHooks(withLookoutHooks(existing, NODE, SCRIPT))).toEqual(existing);
		expect(withoutLookoutHooks(withLookoutHooks({}, NODE, SCRIPT))).toEqual({});
	});
});

describe("lineDiff", () => {
	it("marks added and removed lines", () => {
		expect(lineDiff("a\nb\nc", "a\nx\nc")).toBe("- b\n+ x");
		expect(lineDiff("", "a")).toBe("+ a");
	});
});

describe("writing settings", () => {
	const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

	it("writes through a link and keeps the file's permissions", async () => {
		quiet();
		const dir = mkdtempSync(join(tmpdir(), "lookout-settings-"));
		const real = join(dir, "dotfiles-settings.json");
		writeFileSync(real, JSON.stringify(existing), { mode: 0o600 });
		const link = join(dir, "settings.json");
		symlinkSync(real, link);
		const ok = await writeSettings(link, (s) => withLookoutHooks(s, NODE, SCRIPT), true);
		expect(ok).toBe(true);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(statSync(real).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(real, "utf8")).hooks.SessionStart).toBeDefined();
	});

	it("shows the change again when the file changed while you were reading", async () => {
		quiet();
		const path = join(mkdtempSync(join(tmpdir(), "lookout-settings-")), "settings.json");
		writeFileSync(path, JSON.stringify(existing));
		let calls = 0;
		const change = (current: Settings) => {
			// Claude Code saves a permission while the diff is on screen.
			if (calls++ === 0) writeFileSync(path, JSON.stringify({ ...current, theme: "dark" }));
			return withLookoutHooks(current, NODE, SCRIPT);
		};
		expect(await writeSettings(path, change, true)).toBe(true);
		expect(calls).toBe(2);
		expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("dark");
	});

	it("does nothing before you agree and refuses a file that isn't JSON", async () => {
		quiet();
		const path = join(mkdtempSync(join(tmpdir(), "lookout-settings-")), "settings.json");
		writeFileSync(path, "{ not json");
		let prepared = false;
		await expect(
			writeSettings(
				path,
				(s) => s,
				true,
				() => {
					prepared = true;
				},
			),
		).rejects.toThrow(/isn't valid JSON/);
		expect(prepared).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});
});

describe("node for the hooks", () => {
	it("follows a link that only lives as long as one shell", () => {
		const dir = mkdtempSync(join(tmpdir(), "lookout-node-"));
		const installed = join(dir, "node-versions", "v24", "bin");
		mkdirSync(installed, { recursive: true });
		writeFileSync(join(installed, "node"), "");
		const shell = join(dir, "fnm_multishells", "123_456", "bin");
		mkdirSync(shell, { recursive: true });
		symlinkSync(join(installed, "node"), join(shell, "node"));
		expect(nodeOnPath(shell)).toBe(realpathSync(join(installed, "node")));
		expect(nodeOnPath(installed)).toBe(join(installed, "node"));
	});
});
