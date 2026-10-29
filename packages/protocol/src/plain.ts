/** Lines that only shape Markdown: code fences, rules and a table's divider row. */
const LAYOUT_LINE = /^\s*(```|~~~|([-*_])(\s*\2){2,}\s*$|\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$)/;

/**
 * The first line of Markdown that says something, as plain text, for places that show a single
 * line: a session's summary and a notification. Words are kept; only the markup goes. A heading
 * such as "Summary" says little alone, so the line after it comes along.
 */
export function plainLine(markdown: string | undefined): string | undefined {
	const parts: string[] = [];
	for (const line of markdown?.split("\n") ?? []) {
		if (LAYOUT_LINE.test(line)) continue;
		const plain = stripMarkup(line);
		if (!plain) continue;
		parts.push(plain);
		if (!HEADING.test(line) || parts.length === 2) break;
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

const HEADING = /^\s*#{1,6}\s/;

/** Stands in for a backslash-escaped character while the markup around it goes. */
const HELD = "\uE000";

function stripMarkup(line: string): string {
	const held: string[] = [];
	let text = line
		.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, char: string) => {
			held.push(char);
			return HELD;
		})
		.replace(/^\s*(#{1,6}\s+|>\s*)+/, "")
		.replace(/^\s*([-*+]|\d+[.)])\s+/, "")
		.replace(/^\[([ xX])\]\s+/, (_, mark: string) => (mark === " " ? "☐ " : "☑ "))
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`+([^`]+?)`+/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1$2")
		.replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1$2");
	if (/^\s*\|.*\|\s*$/.test(text)) {
		text = text
			.trim()
			.slice(1, -1)
			.split("|")
			.map((cell) => cell.trim())
			.join(" · ");
	}
	return text.replace(new RegExp(HELD, "g"), () => held.shift() ?? "").trim();
}
