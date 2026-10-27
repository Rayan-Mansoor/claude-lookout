import {
	formatDuration,
	type PermissionRequest,
	type Question,
	type QuestionOption,
	type SessionView,
	type Subagent,
	type TaskProgress,
	type ToolCall,
} from "@claude-lookout/protocol";
import type { ComponentChildren } from "preact";
import { back } from "./router.ts";
import {
	clockTime,
	describeActivity,
	label,
	MODE_LABELS,
	START_LABELS,
	sessionTitle,
	stateLabel,
	stateTone,
	text,
} from "./session-format.ts";
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
					{permission.detail && permission.detail !== permission.target && (
						<Block mono>{permission.detail}</Block>
					)}
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
					<p>{q.question}</p>
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
					<Block>{plan}</Block>
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
}: {
	machine: MachineState | undefined;
	sessionId: string;
	now: number;
	loading: boolean;
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

	return (
		<main class="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-12">
			<header class="flex items-center gap-2">
				<BackButton />
				<div class="min-w-0">
					<h1 class="truncate text-lg font-semibold tracking-tight">{sessionTitle(session)}</h1>
					<p class="truncate text-sm text-muted">{machine.snapshot.machine.name}</p>
				</div>
			</header>

			<div class="mt-6 space-y-4">
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
						<p class="break-words font-mono text-[13px]">{describeActivity(activity)}</p>
					)}
					{error && <p class="text-sm text-halt">{error}</p>}
				</Panel>

				<NeedsYou session={session} />

				{(prompt || lastMessage) && (
					<Panel>
						{prompt && (
							<Section title="Your last prompt">
								<Block>{prompt}</Block>
							</Section>
						)}
						{lastMessage && (
							<Section title="Claude's last message">
								<Block>{lastMessage}</Block>
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
