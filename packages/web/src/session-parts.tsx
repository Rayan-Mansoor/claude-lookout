import type {
	FileChange,
	GitCommit,
	GitEvent,
	PermissionRequest,
	Question,
	QuestionOption,
	SessionView,
	Step,
	TextEdit,
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
	text,
} from "./session-format.ts";

export function Section({ title, children }: { title: string; children: ComponentChildren }) {
	return (
		<section class="space-y-2.5">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted">{title}</h2>
			{children}
		</section>
	);
}

export function Block({ children, mono }: { children: ComponentChildren; mono?: boolean }) {
	return (
		<div
			class={`overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-3 text-sm leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}
		>
			{children}
		</div>
	);
}

export function Panel({
	children,
	attention,
}: {
	children: ComponentChildren;
	attention?: boolean;
}) {
	return (
		<div
			class={`space-y-5 rounded-2xl border bg-surface p-4 ${attention ? "border-lamp/60" : "border-line"}`}
		>
			{children}
		</div>
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
			class="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
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
		<header class="flex items-start gap-2">
			<BackButton label={backLabel} />
			<div class="min-w-0 pt-0.5">
				<h1 class="text-lg font-semibold leading-snug tracking-tight break-words">{title}</h1>
				{subtitle && <p class="truncate text-sm text-muted">{subtitle}</p>}
			</div>
		</header>
	);
}

/**
 * Content cut to a few lines while it is longer than that: either "Show all" opens it in place, or
 * `more` links to the screen that shows it whole.
 */
export function Clamp({
	lines,
	more,
	children,
}: {
	lines: number;
	more?: { href: string; label: string };
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
	return (
		<div>
			<div
				ref={ref}
				class="relative overflow-hidden"
				style={open ? undefined : { maxHeight: `${lines * 1.625}em` }}
			>
				<div ref={content}>{children}</div>
				{cut && !open && (
					<div class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-b from-transparent to-surface" />
				)}
			</div>
			{cut &&
				(more ? (
					<Link
						href={more.href}
						class="mt-2 inline-block text-sm font-medium underline-offset-4 hover:underline"
					>
						{more.label}
					</Link>
				) : (
					<button
						type="button"
						class="mt-2 text-sm font-medium underline-offset-4 hover:underline"
						onClick={() => setOpen(!open)}
					>
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
		<figure class="overflow-hidden rounded-lg border border-line bg-surface">
			{label && (
				<figcaption class="border-b border-line px-3 py-1 text-xs text-muted">{label}</figcaption>
			)}
			<div class="py-1 font-mono text-[13px] leading-relaxed">{rows}</div>
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
		<li class="space-y-1 rounded-xl border border-line px-3.5 py-2 text-sm">
			<p class="font-medium">{option.label}</p>
			{option.description && <p class="text-muted">{option.description}</p>}
			{option.preview && (
				<Clamp lines={PREVIEW_LINES}>
					<pre class="overflow-x-auto whitespace-pre rounded-xl bg-surface-2 px-3.5 py-3 font-mono text-[13px] leading-relaxed">
						{option.preview}
					</pre>
				</Clamp>
			)}
		</li>
	);
}

/** What Claude is waiting on, in full: why you opened the session. */
export function NeedsYou({ session }: { session: SessionView }) {
	const f = session.fields;
	const permission = f.permission as PermissionRequest | undefined;
	const questions = f.questions as Question[] | undefined;
	const plan = text(f.plan);
	if (!permission && !questions?.length && !plan) return null;

	return (
		<Panel attention>
			{permission && (
				<Section title="Permission requested">
					<p>
						<span class="font-medium">{permission.tool}</span>
						{permission.target && <span class="text-muted"> · {permission.target}</span>}
					</p>
					<Clamp lines={REQUEST_LINES}>
						<div class="space-y-2.5">
							{permission.detail &&
								permission.detail !== permission.target &&
								(permission.tool === "Write" ? (
									<CodeBlock code={permission.detail} lang={fileType(permission.target)} />
								) : (
									<Block mono>{permission.detail}</Block>
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
						<p class="text-sm text-muted">
							Can be allowed from now on with{" "}
							<code class="font-mono text-[13px] text-ink">
								{permission.suggestions.join(", ")}
							</code>
						</p>
					)}
				</Section>
			)}
			{questions?.map((q) => (
				<Section key={q.question} title={q.header ?? "Claude is asking"}>
					<div class="space-y-2">
						<InlineMarkdown source={q.question} />
					</div>
					<ul class="space-y-1.5">
						{(q.options as (QuestionOption | string)[]).map(asOption).map((option, i) => (
							<OptionRow key={i} option={option} />
						))}
					</ul>
					{q.multiSelect && <p class="text-sm text-muted">More than one can be chosen.</p>}
				</Section>
			))}
			{plan && (
				<Section title="Plan to approve">
					<Clamp lines={REQUEST_LINES}>
						<Markdown source={plan} />
					</Clamp>
				</Section>
			)}
		</Panel>
	);
}

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
		<ul class="divide-y divide-line">
			{[...steps].reverse().map((step, i) => {
				const outcome = step.outcome && OUTCOMES[step.outcome];
				return (
					<li key={`${step.at}-${i}`} class="flex items-baseline gap-3 py-1.5 text-sm">
						<span class="w-4 shrink-0 text-center" aria-hidden="true">
							{step === running ? (
								<span class="pulse inline-block size-2 rounded-full bg-working" />
							) : (
								<span class={outcome?.tone ?? "text-muted"}>{outcome?.mark ?? "·"}</span>
							)}
						</span>
						<span class="sr-only">
							{step === running ? "Running" : (outcome?.label ?? "Stopped")}
						</span>
						<span class="min-w-0 flex-1 break-words font-mono text-[13px]">
							{step === running ? describeStep(step, now) : describeActivity(step)}
						</span>
						{step.outcome === "failed" && <span class="shrink-0 text-xs text-halt">failed</span>}
						{step.outcome === "denied" && (
							<span class="shrink-0 text-xs text-halt">not allowed</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}

export function More({ count }: { count: number }) {
	return count > 0 ? <p class="text-sm text-muted">and {count} more</p> : null;
}

const FILE_BADGES: Record<Exclude<FileChange["status"], "changed">, string> = {
	new: "bg-done-soft text-done",
	deleted: "bg-halt-soft text-halt",
	conflict: "bg-lamp-soft text-lamp",
};

function Lines({ added, removed }: { added: number; removed: number }) {
	return (
		<span class="shrink-0 tabular-nums">
			{added > 0 && <span class="text-done">+{added}</span>}
			{added > 0 && removed > 0 && " "}
			{removed > 0 && <span class="text-halt">−{removed}</span>}
		</span>
	);
}

export function CommitRow({ commit }: { commit: GitCommit }) {
	return (
		<li class="flex items-baseline gap-3 py-1.5 text-sm">
			<span class="shrink-0 font-mono text-[13px] text-muted">{commit.sha}</span>
			<span class="min-w-0 flex-1 break-words">{commit.subject}</span>
			{commit.unpushed && (
				<span class="shrink-0 rounded-full bg-lamp-soft px-2 py-px text-xs text-lamp">
					not pushed
				</span>
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
		<li class="flex items-baseline gap-3 py-1.5 text-sm">
			<span class="w-12 shrink-0 text-xs tabular-nums text-muted">{clockTime(event.at, now)}</span>
			<span class="min-w-0 flex-1 break-words">
				{describeGitEvent(event)}
				{dropped.length > 0 && (
					<span class="block text-muted">{dropped.map((d) => `“${d}”`).join(", ")}</span>
				)}
			</span>
			{event.by && (
				<span class="shrink-0 rounded-full bg-idle-soft px-2 py-px text-xs text-idle">
					{BY_LABELS[event.by]}
				</span>
			)}
		</li>
	);
}

export function FileRow({ file }: { file: FileChange }) {
	return (
		<li class="flex items-baseline gap-3 py-1.5 text-sm">
			<span class="min-w-0 flex-1 break-all font-mono text-[13px]">{file.path}</span>
			{file.status !== "changed" && (
				<span class={`shrink-0 rounded-full px-2 py-px text-xs ${FILE_BADGES[file.status]}`}>
					{file.status}
				</span>
			)}
			<Lines added={file.added} removed={file.removed} />
		</li>
	);
}

export function Info({ rows }: { rows: [string, string | undefined][] }) {
	const shown = rows.filter((row): row is [string, string] => !!row[1]);
	if (shown.length === 0) return null;
	return (
		<dl class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
			{shown.map(([name, value]) => (
				<div key={name} class="contents">
					<dt class="text-muted">{name}</dt>
					<dd class="min-w-0 break-words">{value}</dd>
				</div>
			))}
		</dl>
	);
}
