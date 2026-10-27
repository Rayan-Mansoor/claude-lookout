import { chmodSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

const ENTRY = "claude-lookout.js";

// Bundles the CLI and the protocol into one self-contained file, so setup can copy a
// single script into ~/.claude-lookout and the hooks never depend on node_modules.
export default defineConfig({
	build: {
		ssr: "src/cli.ts",
		outDir: "dist",
		target: "node22",
		minify: false,
		rollupOptions: {
			output: { entryFileNames: ENTRY },
		},
	},
	ssr: { noExternal: true },
	plugins: [
		{
			// A fresh build would otherwise not be runnable, and `npx claude-lookout` needs to run it.
			name: "runnable-cli",
			writeBundle(options) {
				chmodSync(join(options.dir ?? "dist", ENTRY), 0o755);
			},
		},
	],
});
