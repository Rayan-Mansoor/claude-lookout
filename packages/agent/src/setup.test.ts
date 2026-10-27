import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEntry } from "./setup.ts";

describe("installEntry", () => {
	let root: string;
	let dist: string;
	let app: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lookout-install-"));
		dist = join(root, "dist");
		app = join(root, "home", "app");
		mkdirSync(dist);
		writeFileSync(join(dist, "claude-lookout.js"), "// cli");
		vi.stubEnv("CLAUDE_LOOKOUT_HOME", join(root, "home"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("installs the dashboard when started through a link, as npx does", () => {
		mkdirSync(join(dist, "web"));
		writeFileSync(join(dist, "web", "index.html"), "new");
		mkdirSync(join(root, "bin"));
		symlinkSync(join(dist, "claude-lookout.js"), join(root, "bin", "claude-lookout"));

		const entry = installEntry(join(root, "bin", "claude-lookout"));

		expect(entry).toBe(join(app, "claude-lookout.js"));
		expect(readFileSync(entry, "utf8")).toBe("// cli");
		expect(readFileSync(join(app, "web", "index.html"), "utf8")).toBe("new");
	});

	it("keeps the installed dashboard when the build has none", () => {
		mkdirSync(join(app, "web"), { recursive: true });
		writeFileSync(join(app, "web", "index.html"), "old");

		installEntry(join(dist, "claude-lookout.js"));

		expect(readFileSync(join(app, "web", "index.html"), "utf8")).toBe("old");
		expect(console.warn).toHaveBeenCalled();
	});

	it("leaves everything alone when run from the installed copy", () => {
		mkdirSync(join(app, "web"), { recursive: true });
		writeFileSync(join(app, "claude-lookout.js"), "// installed");
		writeFileSync(join(app, "web", "index.html"), "old");

		installEntry(join(app, "claude-lookout.js"));

		expect(readFileSync(join(app, "claude-lookout.js"), "utf8")).toBe("// installed");
		expect(existsSync(join(app, "web", "index.html"))).toBe(true);
		expect(console.warn).not.toHaveBeenCalled();
	});
});
