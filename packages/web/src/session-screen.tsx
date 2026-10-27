import {
	type FileChange,
	formatDuration,
	type GitCommit,
	type GitEvent,
	type GitSummary,
	type PermissionRequest,
	type Question,
	type QuestionOption,
	type SessionView,
	type Step,
	type Subagent,
	type TaskProgress,
	type TextEdit,
	type ToolCall,
	type WorkingChanges,
} from "@claude-lookout/protocol";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { lineDiff } from "./line-diff.ts";
import { CodeBlock, InlineMarkdown, Markdown } from "./markdown.tsx";
import { back } from "./router.ts";
import {
	busyLine,
	clockTime,
	describeActivity,
	describeGitEvent,
	describeStep,
	label,
	MODE_LABELS,
	plural,
	runningStep,
	START_LABELS,
	sessionProject,
	sessionTitle,
	stateLabel,
	stateTone,
	text,
	upstreamLine,
} from "./session-format.ts";

/** Files listed before the rest are summed up as "and N more". */
const FILES_SHOWN = 30;

import type { MachineState } from "./space.ts";

function Section({ title, children }: { title: string; children: ComponentChildren }) {
	return (
		<section class="space-y-2.5">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted">{title}</h2>
			{children}
		</section>
	);
}

function Block({ children, mono }: { children: ComponentChildren; mono?: boolean }) {
	return (
		<div
			class={`overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-3 text-sm leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}
		>
			{children}
		</div>
	);
}

function Panel({ children, attention }: { children: ComponentChildren; attention?: boolean }) {
	return (
		<div
			class={`space-y-5 rounded-2xl border bg-surface p-4 ${attention ? "border-lamp/60" : "border-line"}`}
		>
			{children}
		</div>
	);
}

function BackButton() {
	return (
		<button
			type="button"
			class="-ml-2 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
			aria-label="Back to all sessions"
			onClick={back}
		>
			<svg viewBox="0 0 20 20" class="size-5" aria-hidden="true">
				<path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" />
			</svg>
		</button>
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
				<pre class="overflow-x-auto whitespace-pre rounded-xl bg-surface-2 px-3.5 py-3 font-mono text-[13px] leading-relaxed">
					{option.preview}
				</pre>
			)}
		</li>
	);
}

/** What Claude is waiting on, in full. Shown first because it's why you opened the session. */
function NeedsYou({ session }: { session: SessionView }) {
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
					<Markdown source={plan} />
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
function Steps({ session, now }: { session: SessionView; now: number }) {
	const steps = (session.fields.steps as Step[] | undefined) ?? [];
	if (steps.length === 0) return null;
	const running = runningStep(session);
	return (
		<Panel>
			<Section title="Recent steps">
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
								{step.outcome === "denied" && (
									<span class="shrink-0 text-xs text-halt">not allowed</span>
								)}
							</li>
						);
					})}
				</ul>
			</Section>
		</Panel>
	);
}

function More({ count }: { count: number }) {
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

function CommitRow({ commit }: { commit: GitCommit }) {
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

function GitEventRow({ event, now }: { event: GitEvent; now: number }) {
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

function FileRow({ file }: { file: FileChange }) {
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

/** How far the session has got: what it did in git, and what is changed but not committed. */
function Progress({ session, now }: { session: SessionView; now: number }) {
	const f = session.fields;
	const changes = f.changes as WorkingChanges | undefined;
	const git = f.git as GitSummary | undefined;
	const commits = (f.gitCommits as GitCommit[] | undefined) ?? [];
	const activity = (f.gitActivity as GitEvent[] | undefined) ?? [];
	const made = commits.filter((c) => !c.earlier);
	const rewritten = commits.filter((c) => c.earlier);
	const edited = (f.edited as string[] | undefined) ?? [];
	const changed = changes?.files.map((file) => file.path) ?? [];
	// Edits are relative to the session's folder, changes to the repository, which may sit above it.
	const editedMatchesChanges =
		edited.length === changes?.total &&
		edited.every((p) => changed.some((c) => c === p || c.endsWith(`/${p}`)));
	if (!changes && !git && !activity.length && !edited.length) return null;

	return (
		<Panel>
			{(git?.busy || git?.upstream) && (
				<Section title="Git">
					{git.busy && <p class="text-sm text-lamp">{busyLine(git.busy)}</p>}
					{git.upstream && <p class="text-sm">{upstreamLine(git.upstream)}</p>}
				</Section>
			)}
			{git && git.commits > 0 && (
				<Section title="Commits this session">
					{made.length > 0 ? (
						<>
							<ul class="divide-y divide-line">
								{made.map((commit) => (
									<CommitRow key={commit.sha} commit={commit} />
								))}
							</ul>
							<More count={git.commits - made.length} />
						</>
					) : (
						<p class="text-sm">{plural(git.commits, "commit")}</p>
					)}
				</Section>
			)}
			{git && git.earlier > 0 && (
				<Section title="Earlier commits rewritten">
					{rewritten.length > 0 ? (
						<>
							<ul class="divide-y divide-line">
								{rewritten.map((commit) => (
									<CommitRow key={commit.sha} commit={commit} />
								))}
							</ul>
							<More count={git.earlier - rewritten.length} />
						</>
					) : (
						<p class="text-sm">{plural(git.earlier, "commit")}</p>
					)}
				</Section>
			)}
			{activity.length > 0 && (
				<Section title="Git activity">
					<ul class="divide-y divide-line">
						{activity.map((event, i) => (
							<GitEventRow key={`${event.at}-${i}`} event={event} now={now} />
						))}
					</ul>
				</Section>
			)}
			{changes && (
				<Section title="Not committed yet">
					<p class="text-sm text-muted tabular-nums">
						{plural(changes.total, "file")} · <span class="text-done">+{changes.added}</span>{" "}
						<span class="text-halt">−{changes.removed}</span>
					</p>
					<ul class="divide-y divide-line">
						{changes.files.slice(0, FILES_SHOWN).map((file) => (
							<FileRow key={file.path} file={file} />
						))}
					</ul>
					<More count={changes.total - Math.min(changes.files.length, FILES_SHOWN)} />
				</Section>
			)}
			{edited.length > 0 && !editedMatchesChanges && (
				<Section title="Edited by this session">
					<ul class="divide-y divide-line">
						{edited.slice(0, FILES_SHOWN).map((path) => (
							<li key={path} class="break-all py-1.5 font-mono text-[13px]">
								{path}
							</li>
						))}
					</ul>
					<More count={edited.length - FILES_SHOWN} />
				</Section>
			)}
		</Panel>
	);
}

function Info({ rows }: { rows: [string, string | undefined][] }) {
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

/** One session, everything claude-lookout knows about it, kept live. */
export function SessionScreen({
	machine,
	sessionId,
	now,
	loading,
	offlineFor,
}: {
	machine: MachineState | undefined;
	sessionId: string;
	now: number;
	loading: boolean;
	/** How long the machine has been silent, when it counts as offline. */
	offlineFor?: number | undefined;
}) {
	const session = machine?.snapshot.sessions.find((s) => s.id === sessionId);

	if (!machine || !session) {
		return (
			<main class="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-10">
				<BackButton />
				<p class="mt-10 text-center text-muted">
					{loading ? "Loading…" : "This session has closed and is no longer shown."}
				</p>
			</main>
		);
	}

	const f = session.fields;
	const tone = stateTone(session);
	const activity = f.activity as ToolCall | undefined;
	const tasks = f.tasks as TaskProgress | undefined;
	const subagents = f.subagents as Subagent[] | undefined;
	const error = text(f.error);
	const prompt = text(f.prompt);
	const lastMessage = text(f.lastMessage);
	// Once the run ends, Claude's last message says the same thing in full.
	const narration = session.state === "finished" ? undefined : text(f.narration);
	const step = runningStep(session);

	return (
		<main class="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-12">
			<header class="flex items-center gap-2">
				<BackButton />
				<div class="min-w-0">
					<h1 class="text-lg font-semibold leading-snug tracking-tight break-words">
						{sessionTitle(session)}
					</h1>
					<p class="truncate text-sm text-muted">
						{[sessionProject(session), machine.snapshot.machine.name].filter(Boolean).join(" · ")}
					</p>
				</div>
			</header>

			<div class="mt-6 space-y-4">
				{offlineFor !== undefined && (
					<p class="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
						{machine.snapshot.machine.name} is offline · last seen {formatDuration(offlineFor)} ago.
						This is the last known state.
					</p>
				)}
				<Panel>
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span
							class={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${tone.badge}`}
						>
							<span class={`size-2 rounded-full ${tone.dot}`} aria-hidden="true" />
							{stateLabel(session)}
						</span>
						<span class="text-sm text-muted">
							for {formatDuration(now - session.since)} · since {clockTime(session.since, now)}
						</span>
					</div>
					{activity && session.state === "working" && (
						<p class="break-words font-mono text-[13px]">
							{step ? describeStep(step, now) : describeActivity(activity)}
						</p>
					)}
					{error && <p class="text-sm text-halt">{error}</p>}
				</Panel>

				<NeedsYou session={session} />

				{(prompt || narration || lastMessage) && (
					<Panel>
						{prompt && (
							<Section title="Your last prompt">
								<Block>{prompt}</Block>
							</Section>
						)}
						{narration && (
							<Section title="Claude's latest update">
								<Markdown source={narration} />
							</Section>
						)}
						{lastMessage && (
							<Section title="Claude's last message">
								<Markdown source={lastMessage} />
							</Section>
						)}
					</Panel>
				)}

				{((tasks && tasks.total > 0) || subagents?.length) && (
					<Panel>
						{tasks && tasks.total > 0 && (
							<Section title="Tasks">
								<div class="flex items-center gap-3">
									<div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
										<div
											class="h-full rounded-full bg-working transition-[width] duration-300"
											style={{ width: `${(tasks.done / tasks.total) * 100}%` }}
										/>
									</div>
									<span class="text-sm tabular-nums text-muted">
										{tasks.done} of {tasks.total} done
									</span>
								</div>
								{tasks.current && <p class="text-sm">{tasks.current}</p>}
							</Section>
						)}
						{subagents && subagents.length > 0 && (
							<Section title="Subagents running">
								<p class="text-sm">{subagents.map((a) => a.type).join(", ")}</p>
							</Section>
						)}
					</Panel>
				)}

				<Steps session={session} now={now} />

				<Progress session={session} now={now} />

				<Panel>
					<Section title="Session">
						<Info
							rows={[
								["Model", text(f.model)],
								["Mode", label(MODE_LABELS, f.mode)],
								["Effort", text(f.effort)],
								["Branch", text(f.branch)],
								["Folder", text(f.cwd)],
								["Started", label(START_LABELS, f.startedFrom)],
								["Opened", clockTime(session.startedAt, now)],
								["Last update", `${formatDuration(now - session.updatedAt)} ago`],
							]}
						/>
					</Section>
				</Panel>
			</div>
		</main>
	);
}
