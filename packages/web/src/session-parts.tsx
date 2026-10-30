import {
	type FileChange,
	formatDuration,
	type GitCommit,
	type GitEvent,
	type PermissionRequest,
	type Question,
	type QuestionOption,
	type SessionView,
	type Step,
	type TextEdit,
} from "@claude-lookout/protocol";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { lineDiff } from "./line-diff.ts";
import { CodeBlock, InlineMarkdown, Markdown } from "./markdown.tsx";
import { back, navigate } from "./router.ts";
import {
	clockTime,
	type DigestPart,
	describeActivity,
	describeGitEvent,
	describeStep,
	runningStep,
	stateLabel,
	stateTone,
	text,
} from "./session-format.ts";

/** A session's lamp: its state at a glance, in colour, fill and motion. */
export function Lamp({ session, small }: { session: SessionView; small?: boolean }) {
	return (
		<span
			class={`inline-block shrink-0 rounded-full ${small ? "size-2" : "size-2.5"} ${stateTone(session).lamp}`}
			aria-hidden="true"
		/>
	);
}

/** The lamp, the state's name in its colour, and how long it has held. */
export function StateLine({ session, now }: { session: SessionView; now: number }) {
	return (
		<p class="flex items-center gap-2.5">
			<Lamp session={session} />
			<span class={`font-semibold ${stateTone(session).text}`}>{stateLabel(session)}</span>
			<span class="text-meta text-muted">for {formatDuration(now - session.since)}</span>
		</p>
	);
}

export function Section({
	title,
	aside,
	tone,
	children,
}: {
	title: string;
	/** A count or total shown at the end of the heading. */
	aside?: ComponentChildren;
	tone?: string;
	children: ComponentChildren;
}) {
	return (
		<section class="space-y-2.5">
			<div class="flex items-baseline justify-between gap-3">
				<h2 class={`font-semibold ${tone ?? ""}`}>{title}</h2>
				{aside && <span class="text-meta text-muted">{aside}</span>}
			</div>
			{children}
		</section>
	);
}

export function Block({ children, mono }: { children: ComponentChildren; mono?: boolean }) {
	return (
		<div
			class={`overflow-x-auto whitespace-pre-wrap break-words rounded-small bg-surface-2 px-3 py-2.5 leading-relaxed ${mono ? "font-mono text-mono" : ""}`}
		>
			{children}
		</div>
	);
}

/** The one container: around what Claude asks of you, or around a group of rows. */
export function Box({ children, attention }: { children: ComponentChildren; attention?: boolean }) {
	return (
		<div
			class={`space-y-3 rounded-box border p-4 ${attention ? "border-lamp/45 bg-lamp-soft" : "border-line bg-surface"}`}
		>
			{children}
		</div>
	);
}

const STRIP_TONES = {
	lamp: { box: "border-lamp/45 bg-lamp-soft", dot: "bg-lamp" },
	halt: { box: "border-halt/40 bg-halt-soft", dot: "bg-halt" },
	muted: { box: "border-line bg-surface-2 text-muted", dot: "border-2 border-idle" },
};

/** A problem that won't clear by itself, on one line above everything else. */
export function Strip({
	tone,
	children,
}: {
	tone: keyof typeof STRIP_TONES;
	children: ComponentChildren;
}) {
	const style = STRIP_TONES[tone];
	return (
		<p
			class={`flex items-baseline gap-2.5 rounded-box border px-3.5 py-3 text-[0.875rem] ${style.box}`}
		>
			<span
				class={`inline-block size-2 shrink-0 translate-y-[-1px] rounded-full ${style.dot}`}
				aria-hidden="true"
			/>
			<span class="min-w-0 break-words">{children}</span>
		</p>
	);
}

/** A link inside the dashboard that opens without reloading the page. */
export function Link({
	href,
	class: className,
	children,
}: {
	href: string;
	class?: string;
	children: ComponentChildren;
}) {
	return (
		<a
			href={href}
			class={className}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey) return;
				event.preventDefault();
				navigate(href);
			}}
		>
			{children}
		</a>
	);
}

function BackButton({ label }: { label: string }) {
	return (
		<button
			type="button"
			class="-ml-2.5 flex size-9 shrink-0 items-center justify-center rounded-small text-muted transition-colors hover:bg-surface-2 hover:text-ink"
			aria-label={label}
			onClick={back}
		>
			<svg viewBox="0 0 20 20" class="size-5" aria-hidden="true">
				<path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" />
			</svg>
		</button>
	);
}

/** The top of every session screen: a way back, what this screen is, and what it belongs to. */
export function ScreenHeader({
	title,
	subtitle,
	backLabel,
}: {
	title: string;
	subtitle?: string | undefined;
	backLabel: string;
}) {
	return (
		<header class="flex items-start gap-1.5">
			<BackButton label={backLabel} />
			<div class="min-w-0 pt-0.5">
				<h1 class="text-title font-semibold break-words">{title}</h1>
				{subtitle && <p class="truncate text-meta text-muted">{subtitle}</p>}
			</div>
		</header>
	);
}

/**
 * Content cut to a few lines while it is longer than that: either "Show all" opens it in place, or
 * `more` links to the screen that shows it whole. `fade` is the background it fades into.
 */
export function Clamp({
	lines,
	more,
	fade = "to-bg",
	children,
}: {
	lines: number;
	more?: { href: string; label: string };
	fade?: "to-bg" | "to-lamp-soft" | "to-surface";
	children: ComponentChildren;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const [cut, setCut] = useState(false);
	const [open, setOpen] = useState(false);
	// Measured when the content or the window changes size, not on every redraw (one a second).
	useLayoutEffect(() => {
		const box = ref.current;
		const inner = content.current;
		if (!box || !inner || open) return;
		const measure = () => setCut(inner.offsetHeight > box.clientHeight + 1);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(inner);
		observer.observe(box);
		return () => observer.disconnect();
	}, [open]);
	const link =
		"mt-2 inline-block border-b border-line text-[0.875rem] font-medium transition-colors hover:border-ink";
	return (
		<div>
			<div
				ref={ref}
				class="relative overflow-hidden"
				style={open ? undefined : { maxHeight: `${lines * 1.625}em` }}
			>
				<div ref={content}>{children}</div>
				{cut && !open && (
					<div
						class={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent ${fade}`}
					/>
				)}
			</div>
			{cut &&
				(more ? (
					<Link href={more.href} class={link}>
						{more.label}
					</Link>
				) : (
					<button type="button" class={link} onClick={() => setOpen(!open)}>
						{open ? "Show less" : "Show all"}
					</button>
				))}
		</div>
	);
}

const DIGEST_TONES: Record<NonNullable<DigestPart["tone"]>, string> = {
	lamp: "text-lamp",
	halt: "text-halt",
	done: "text-done",
};

/** A section's one-line summary, with its warnings in colour. */
export function Digest({ parts }: { parts: DigestPart[] }) {
	return (
		<>
			{parts.map((part, i) => (
				<span key={i}>
					{i > 0 && (part.glued ? " " : " · ")}
					<span class={part.tone ? DIGEST_TONES[part.tone] : undefined}>{part.text}</span>
				</span>
			))}
		</>
	);
}

/** "ts" for "src/app.ts", so a file's content can be labelled with its kind. */
function fileType(path: string | undefined): string | undefined {
	const name = path?.split("/").at(-1) ?? "";
	return name.includes(".") ? name.split(".").at(-1) : name || undefined;
}

const DIFF_STYLES = {
	same: { line: "", mark: " ", label: "Unchanged" },
	removed: { line: "bg-halt-soft", mark: "−", label: "Removed" },
	added: { line: "bg-done-soft", mark: "+", label: "Added" },
};

function diffRows(edit: TextEdit) {
	return lineDiff(edit.before, edit.after).map((line, i) => {
		const style = DIFF_STYLES[line.kind];
		return (
			<div key={i} class={`flex ${style.line}`}>
				<span class="w-6 shrink-0 select-none text-center text-muted" aria-hidden="true">
					{style.mark}
				</span>
				<span class="sr-only">{style.label}: </span>
				<span class="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">{line.text || " "}</span>
			</div>
		);
	});
}

/**
 * One replacement Claude wants to make, as lines removed and added. Worked out once per edit: the
 * screen redraws every second, and an edit can run to thousands of lines.
 */
function EditDiff({ edit, label }: { edit: TextEdit; label?: string | undefined }) {
	const rows = useMemo(() => diffRows(edit), [edit.before, edit.after]);
	return (
		<figure class="overflow-hidden rounded-small border border-line bg-surface">
			{label && (
				<figcaption class="border-b border-line px-3 py-1 text-meta text-muted">{label}</figcaption>
			)}
			<div class="py-1 font-mono text-mono leading-relaxed">{rows}</div>
		</figure>
	);
}

/** Long requests are cut to this many lines until opened. */
const REQUEST_LINES = 40;

/** An option's mockup or snippet is cut to this many lines until opened. */
const PREVIEW_LINES = 16;

/** An option as sent by any agent version: older ones sent only its label. */
function asOption(option: QuestionOption | string): QuestionOption {
	return typeof option === "string" ? { label: option } : option;
}

/** One choice Claude offers: its label, what it means, and any mockup to compare. */
function OptionRow({ option }: { option: QuestionOption }) {
	return (
		<li class="space-y-1 rounded-small border border-line bg-surface px-3 py-2">
			<p class="text-[0.875rem] font-medium">{option.label}</p>
			{option.description && <p class="text-meta text-muted">{option.description}</p>}
			{option.preview && (
				<div class="pt-1">
					<Clamp lines={PREVIEW_LINES} fade="to-surface">
						<pre class="overflow-x-auto whitespace-pre rounded-small border border-line px-3 py-2 font-mono text-mono leading-relaxed">
							{option.preview}
						</pre>
					</Clamp>
				</div>
			)}
		</li>
	);
}

/** What Claude is waiting on, in full, under the state it put the session in: why you opened it. */
export function NeedsYou({ session, now }: { session: SessionView; now: number }) {
	const f = session.fields;
	const permission = f.permission as PermissionRequest | undefined;
	const questions = f.questions as Question[] | undefined;
	const plan = text(f.plan);
	// Claude Code can report the wait before saying what it waits on; the state alone still shows.
	return (
		<Box attention>
			<StateLine session={session} now={now} />
			{permission && (
				<>
					<p class="break-words">
						<span class="font-semibold">{permission.tool}</span>
						{permission.target && <span class="text-muted"> · {permission.target}</span>}
					</p>
					<Clamp lines={REQUEST_LINES} fade="to-lamp-soft">
						<div class="space-y-2.5">
							{permission.detail &&
								permission.detail !== permission.target &&
								(permission.tool === "Write" ? (
									<CodeBlock code={permission.detail} lang={fileType(permission.target)} />
								) : (
									<div class="overflow-x-auto whitespace-pre-wrap break-all rounded-small bg-surface px-3 py-2.5 font-mono text-mono leading-relaxed">
										{permission.detail}
									</div>
								))}
							{permission.edits?.map((edit, i, all) => (
								<EditDiff
									key={i}
									edit={edit}
									label={all.length > 1 ? `Change ${i + 1} of ${all.length}` : undefined}
								/>
							))}
						</div>
					</Clamp>
					{permission.suggestions.length > 0 && (
						<p class="text-meta text-muted">
							Can be allowed from now on with{" "}
							<code class="font-mono text-ink">{permission.suggestions.join(", ")}</code>
						</p>
					)}
				</>
			)}
			{questions?.map((q) => (
				<div key={q.question} class="space-y-2.5">
					{q.header && <p class="text-meta font-medium text-muted">{q.header}</p>}
					<div class="space-y-2">
						<InlineMarkdown source={q.question} />
					</div>
					<ul class="space-y-1.5">
						{(q.options as (QuestionOption | string)[]).map(asOption).map((option, i) => (
							<OptionRow key={i} option={option} />
						))}
					</ul>
					{q.multiSelect && <p class="text-meta text-muted">More than one can be chosen.</p>}
				</div>
			))}
			{plan && (
				<Clamp lines={REQUEST_LINES} fade="to-lamp-soft">
					<Markdown source={plan} />
				</Clamp>
			)}
		</Box>
	);
}

/** Rows split by thin lines, for every list on the session screens. */
export function Rows({ children }: { children: ComponentChildren }) {
	return <ul class="divide-y divide-line border-y border-line">{children}</ul>;
}

const ROW = "flex items-baseline gap-3 py-2 text-[0.875rem]";

const OUTCOMES: Record<
	NonNullable<Step["outcome"]>,
	{ mark: string; tone: string; label: string }
> = {
	done: { mark: "✓", tone: "text-done", label: "Done" },
	failed: { mark: "✕", tone: "text-halt", label: "Failed" },
	denied: { mark: "✕", tone: "text-halt", label: "Not allowed" },
};

/** The last tool calls, newest first, with how each one went. */
export function StepList({ session, now }: { session: SessionView; now: number }) {
	const steps = (session.fields.steps as Step[] | undefined) ?? [];
	const running = runningStep(session);
	return (
		<Rows>
			{[...steps].reverse().map((step, i) => {
				const outcome = step.outcome && OUTCOMES[step.outcome];
				return (
					<li key={`${step.at}-${i}`} class={ROW}>
						<span class="w-3.5 shrink-0 text-center font-semibold" aria-hidden="true">
							{step === running ? (
								<span class="breathe inline-block size-2 rounded-full bg-working" />
							) : (
								<span class={outcome?.tone ?? "text-muted"}>{outcome?.mark ?? "·"}</span>
							)}
						</span>
						<span class="sr-only">
							{step === running ? "Running" : (outcome?.label ?? "Stopped")}
						</span>
						<span class="min-w-0 flex-1 break-words font-mono text-mono">
							{step === running ? describeStep(step, now) : describeActivity(step)}
						</span>
						{step.outcome === "failed" && <span class="shrink-0 text-meta text-halt">failed</span>}
						{step.outcome === "denied" && (
							<span class="shrink-0 text-meta text-halt">not allowed</span>
						)}
					</li>
				);
			})}
		</Rows>
	);
}

export function More({ count }: { count: number }) {
	return count > 0 ? <p class="text-meta text-muted">and {count} more</p> : null;
}

/** Each file's state as git writes it: added, modified, deleted, unmerged. */
const FILE_MARKS: Record<FileChange["status"], { mark: string; tone: string; label: string }> = {
	new: { mark: "A", tone: "text-done", label: "New" },
	changed: { mark: "M", tone: "text-muted", label: "Changed" },
	deleted: { mark: "D", tone: "text-halt", label: "Deleted" },
	conflict: { mark: "U", tone: "text-lamp", label: "In conflict" },
};

function Lines({ added, removed }: { added: number; removed: number }) {
	return (
		<span class="shrink-0 font-mono text-mono">
			{added > 0 && <span class="text-done">+{added}</span>}
			{added > 0 && removed > 0 && " "}
			{removed > 0 && <span class="text-halt">−{removed}</span>}
		</span>
	);
}

/** The small hollow lamp that marks a commit no remote has yet. */
export function UnpushedMark() {
	return (
		<span
			class="inline-block size-2 shrink-0 rounded-full border-[1.5px] border-lamp"
			aria-hidden="true"
		/>
	);
}

export function CommitRow({ commit }: { commit: GitCommit }) {
	return (
		<li class={ROW}>
			<span class="shrink-0 font-mono text-mono text-muted">{commit.sha}</span>
			<span class="min-w-0 flex-1 break-words">{commit.subject}</span>
			{commit.unpushed && (
				<>
					<UnpushedMark />
					<span class="sr-only">not pushed</span>
				</>
			)}
			<Lines added={commit.added} removed={commit.removed} />
		</li>
	);
}

const BY_LABELS: Record<NonNullable<GitEvent["by"]>, string> = {
	you: "you",
	other: "another session",
};

export function GitEventRow({ event, now }: { event: GitEvent; now: number }) {
	const dropped = event.kind === "reset" ? (event.dropped ?? []) : [];
	return (
		<li class={ROW}>
			<span class="w-11 shrink-0 font-mono text-mono text-muted">{clockTime(event.at, now)}</span>
			<span class="min-w-0 flex-1 break-words">
				{describeGitEvent(event)}
				{dropped.length > 0 && (
					<span class="block text-muted">{dropped.map((d) => `“${d}”`).join(", ")}</span>
				)}
			</span>
			{event.by && <span class="shrink-0 text-meta text-muted">{BY_LABELS[event.by]}</span>}
		</li>
	);
}

export function FileRow({ file }: { file: FileChange }) {
	const mark = FILE_MARKS[file.status];
	return (
		<li class={ROW}>
			<span class={`w-3.5 shrink-0 text-center font-mono text-mono font-semibold ${mark.tone}`}>
				<span aria-hidden="true">{mark.mark}</span>
				<span class="sr-only">{mark.label}</span>
			</span>
			<span class="min-w-0 flex-1 break-all font-mono text-mono">{file.path}</span>
			<Lines added={file.added} removed={file.removed} />
		</li>
	);
}

export function Info({ rows }: { rows: [string, string | undefined][] }) {
	const shown = rows.filter((row): row is [string, string] => !!row[1]);
	if (shown.length === 0) return null;
	return (
		<dl class="grid grid-cols-[auto_1fr] border-t border-line text-[0.875rem]">
			{shown.map(([name, value]) => (
				<div key={name} class="contents">
					<dt class="border-b border-line py-2.5 pr-6 text-muted">{name}</dt>
					<dd class="min-w-0 break-words border-b border-line py-2.5">{value}</dd>
				</div>
			))}
		</dl>
	);
}
