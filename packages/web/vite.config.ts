import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
	build: { target: "es2022", sourcemap: false },
	server: { port: 5199 },
});
