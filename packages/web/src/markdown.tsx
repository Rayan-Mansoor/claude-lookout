import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";

/**
 * Markdown as Preact elements, never as HTML: anything Claude writes, raw HTML included, shows up
 * as text. Nothing is dropped, so a construct we don't style still appears as it was written.
 * Read once per text: the screen redraws every second, and a reply can be long.
 */
export function Markdown({ source }: { source: string }) {
	const tree = useMemo(() => blocks(lexer(source, { gfm: true })), [source]);
	return (
		<div class="space-y-3 break-words rounded-xl bg-surface-2 px-3.5 py-3 text-sm leading-relaxed">
			{tree}
		</div>
	);
}

/** Markdown inside a line of its own, such as a question. */
export function InlineMarkdown({ source }: { source: string }) {
	const tree = useMemo(() => blocks(lexer(source, { gfm: true })), [source]);
	return <>{tree}</>;
}

const HEADING_SIZES = ["text-base", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"];

function blocks(tokens: Token[]): ComponentChildren[] {
	return tokens.map((token, i) => block(token, i));
}

function block(any: Token, key: number): ComponentChildren {
	const t = any as Tokens.Generic;
	const token = any as MarkedToken;
	switch (token.type) {
		case "space":
		case "def":
			// Reference definitions already live in the links that use them.
			return null;
		case "heading":
			return (
				<p key={key} class={`font-semibold ${HEADING_SIZES[token.depth - 1]}`}>
					{inline(token.tokens)}
				</p>
			);
		case "paragraph":
			return <p key={key}>{inline(token.tokens)}</p>;
		case "text":
			return <p key={key}>{token.tokens ? inline(token.tokens) : decode(token.text)}</p>;
		case "code":
			return <CodeBlock key={key} code={token.text} lang={token.lang} />;
		case "blockquote":
			return (
				<blockquote key={key} class="space-y-3 border-l-2 border-line pl-3 text-muted">
					{blocks(token.tokens)}
				</blockquote>
			);
		case "list":
			return <List key={key} list={token} />;
		case "table":
			return <Table key={key} table={token} />;
		case "hr":
			return <hr key={key} class="border-line" />;
		case "html":
			return (
				<p key={key} class="whitespace-pre-wrap font-mono text-[13px]">
					{token.text}
				</p>
			);
		default:
			return t.tokens ? (
				<div key={key}>{blocks(t.tokens)}</div>
			) : (
				<p key={key} class="whitespace-pre-wrap">
					{t.raw}
				</p>
			);
	}
}

export function CodeBlock({ code, lang }: { code: string; lang?: string | undefined }) {
	return (
		<figure class="overflow-hidden rounded-lg border border-line bg-surface">
			{lang && (
				<figcaption class="border-b border-line px-3 py-1 font-mono text-xs text-muted">
					{lang}
				</figcaption>
			)}
			<pre class="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[13px] leading-relaxed">
				<code>{code}</code>
			</pre>
		</figure>
	);
}

function List({ list }: { list: Tokens.List }) {
	const items = list.items.map((item, i) => (
		<li key={i} class={item.task ? "flex list-none gap-2" : "pl-1"}>
			{item.task && (
				<span
					class={`mt-0.5 shrink-0 ${item.checked ? "text-done" : "text-muted"}`}
					role="img"
					aria-label={item.checked ? "Done" : "Not done"}
				>
					{item.checked ? "☑" : "☐"}
				</span>
			)}
			<div class="min-w-0 space-y-2">
				{blocks(item.tokens.filter((t) => t.type !== "checkbox"))}
			</div>
		</li>
	));
	return list.ordered ? (
		<ol class="list-decimal space-y-1 pl-5" start={list.start === "" ? undefined : list.start}>
			{items}
		</ol>
	) : (
		<ul class="list-disc space-y-1 pl-5">{items}</ul>
	);
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" };

function Table({ table }: { table: Tokens.Table }) {
	const cell = (c: Tokens.TableCell, i: number) => {
		const Tag = c.header ? "th" : "td";
		return (
			<Tag
				key={i}
				class={`border border-line px-2.5 py-1.5 align-top ${c.align ? ALIGN[c.align] : "text-left"} ${c.header ? "font-semibold" : ""}`}
			>
				{inline(c.tokens)}
			</Tag>
		);
	};
	return (
		<div class="overflow-x-auto">
			<table class="min-w-full border-collapse bg-surface text-[13px]">
				<thead>
					<tr>{table.header.map(cell)}</tr>
				</thead>
				<tbody>
					{table.rows.map((row, i) => (
						<tr key={i}>{row.map(cell)}</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function inline(tokens: Token[]): ComponentChildren[] {
	return tokens.map((any, key) => {
		const t = any as Tokens.Generic;
		const token = any as MarkedToken;
		switch (token.type) {
			case "text":
				return token.tokens ? inline(token.tokens) : decode(token.text);
			case "escape":
				return token.text;
			case "strong":
				return (
					<strong key={key} class="font-semibold">
						{inline(token.tokens)}
					</strong>
				);
			case "em":
				return <em key={key}>{inline(token.tokens)}</em>;
			case "del":
				return <del key={key}>{inline(token.tokens)}</del>;
			case "codespan":
				return (
					<code key={key} class="rounded bg-surface px-1 py-0.5 font-mono text-[13px]">
						{token.text}
					</code>
				);
			case "br":
				return <br key={key} />;
			case "link":
				return <Link key={key} href={token.href} title={token.title} label={token.tokens} />;
			case "image":
				return (
					<span key={key}>
						Image{token.text ? `: ${token.text}` : ""}{" "}
						<Link href={token.href} title={token.title} label={[]} />
					</span>
				);
			case "html":
				return (
					<code key={key} class="font-mono text-[13px]">
						{token.text}
					</code>
				);
			default:
				return t.tokens ? inline(t.tokens) : t.raw;
		}
	});
}

/**
 * Web links open in a new tab. Anything else, such as a path on the machine, can't be opened from
 * here, so it stays as text with its target alongside.
 */
function Link({
	href,
	title,
	label,
}: {
	href: string;
	title?: string | null | undefined;
	label: Token[];
}) {
	const text = label.length > 0 ? inline(label) : null;
	const shown = label.map((t) => t.raw).join("");
	if (/^https?:\/\//i.test(href)) {
		return (
			<a
				href={href}
				title={title ?? href}
				target="_blank"
				rel="noopener noreferrer"
				class="break-all text-working underline underline-offset-2"
			>
				{text ?? href}
			</a>
		);
	}
	return (
		<span title={title ?? undefined}>
			{text}
			{shown !== href && (
				<code class="ml-1 font-mono text-[13px] text-muted">{text ? `(${href})` : href}</code>
			)}
		</span>
	);
}

const ENTITY = /&(#\d+|#x[\da-f]+|[a-z]+\d*);/gi;
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** Markdown text may spell characters as HTML entities; show the characters themselves. */
function decode(text: string): string {
	return text.replace(ENTITY, (whole, name: string) => {
		if (name[0] === "#") {
			const code =
				name[1] === "x" || name[1] === "X"
					? Number.parseInt(name.slice(2), 16)
					: Number(name.slice(1));
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}
