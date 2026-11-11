// Copies the repository README and LICENSE into this package, since npm packs only what sits beside
// package.json. npm can't follow links into the repository, so every relative link in the README
// points to GitHub instead, and what only GitHub draws (diagrams, alert boxes) gets a plain stand-in.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repo = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const raw = `${repo.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/`;
const blob = `${repo}/blob/main/`;

const isRelative = (url) => !/^([a-z]+:|#|\/\/)/i.test(url);
const to = (base) => (url) => (isRelative(url) ? base + url.replace(/^\.\//, "") : url);
const image = to(raw);
const page = to(blob);

const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8")
	.replace(/(src|srcset)="([^"]+)"/g, (_, attr, url) => `${attr}="${image(url)}"`)
	.replace(/href="([^"]+)"/g, (_, url) => `href="${page(url)}"`)
	.replace(/\]\(([^)\s]+)\)/g, (_, url) => `](${page(url)})`)
	.replace(/```mermaid\n[\s\S]*?```/g, `See the diagram [on GitHub](${repo}#how-it-works).`)
	.replace(
		/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/gm,
		(_, kind) => `> **${kind.charAt(0)}${kind.slice(1).toLowerCase()}**`,
	);

writeFileSync(new URL("../README.md", import.meta.url), readme);
copyFileSync(new URL("../../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
