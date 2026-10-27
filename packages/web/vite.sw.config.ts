import { defineConfig } from "vite";

// The service worker is built on its own, as one classic script at a fixed address:
// browsers don't allow `import` in a classic worker, and it must not be content-hashed.
export default defineConfig({
	build: {
		target: "es2022",
		sourcemap: false,
		emptyOutDir: false,
		lib: { entry: "src/sw.ts", formats: ["iife"], name: "lookoutWorker", fileName: () => "sw.js" },
	},
});
