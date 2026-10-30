import type {
	FileChange,
	GitCommit,
	GitEvent,
	GitSummary,
	SessionView,
	Step,
	Subagent,
	TaskProgress,
	WorkingChanges,
} from "@claude-lookout/protocol";
import { formatDuration } from "@claude-lookout/protocol";
import type { ComponentChildren } from "preact";
import { Markdown } from "./markdown.tsx";
import type { Section as SectionName } from "./router.ts";
import {
	busyLine,
	clockTime,
	describeStep,
	label,
	MODE_LABELS,
	modelName,
	plural,
	runningStep,
	START_LABELS,
	sessionTitle,
	text,
	upstreamLine,
} from "./session-format.ts";
import {
	Block,
	CommitRow,
	FileRow,
	GitEventRow,
	Info,
	More,
	Panel,
	ScreenHeader,
	Section,
	StepList,
} from "./session-parts.tsx";

const TITLES: Record<SectionName, string> = {
	conversation: "Conversation",
	activity: "Activity",
	files: "Files",
	git: "Git",
	details: "Details",
};

function Empty({ children }: { children: ComponentChildren }) {
	return <p class="py-10 text-center text-muted">{children}</p>;
}

/** Claude's words first, newest first, then what you asked. */
function Conversation({ session }: { session: SessionView }) {
	const f = session.fields;
	const prompt = text(f.prompt);
	const lastMessage = text(f.lastMessage);
	// Once the run ends, Claude's last message says the same thing in full.
	const narration =
		session.state === "finished" || session.state === "background" ? undefined : text(f.narration);
	if (!prompt && !narration && !lastMessage) return <Empty>Nothing said yet.</Empty>;
	return (
		<>
			{(lastMessage || narration) && (
				<Panel>
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
			{prompt && (
				<Panel>
					<Section title="Your last prompt">
						<Block>{prompt}</Block>
					</Section>
				</Panel>
			)}
		</>
	);
}

/** What runs now, how far the task list got, who helps, and every recent step. */
function Activity({ session, now }: { session: SessionView; now: number }) {
	const f = session.fields;
	const tasks = f.tasks as TaskProgress | undefined;
	const subagents = (f.subagents as Subagent[] | undefined) ?? [];
	const steps = (f.steps as Step[] | undefined) ?? [];
	const step = runningStep(session);
	if (!step && !tasks?.total && !subagents.length && !steps.length) {
		return <Empty>No steps yet.</Empty>;
	}
	return (
		<>
			{step && (
				<Panel>
					<Section title={session.state === "permission" ? "Waiting to run" : "Running now"}>
						<p class="break-words font-mono text-[13px]">{describeStep(step, now)}</p>
						<p class="text-sm text-muted">
							for {formatDuration(now - step.at)} · since {clockTime(step.at, now)}
						</p>
					</Section>
				</Panel>
			)}
			{((tasks && tasks.total > 0) || subagents.length > 0) && (
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
					{subagents.length > 0 && (
						<Section title="Subagents running">
							<p class="text-sm">{subagents.map((a) => a.type).join(", ")}</p>
						</Section>
					)}
				</Panel>
			)}
			{steps.length > 0 && (
				<Panel>
					<Section title="Recent steps">
						<StepList session={session} now={now} />
					</Section>
				</Panel>
			)}
		</>
	);
}

/** Files in conflict first, then everything not committed, then what the session edited. */
function Files({ session }: { session: SessionView }) {
	const f = session.fields;
	const changes = f.changes as WorkingChanges | undefined;
	const edited = (f.edited as string[] | undefined) ?? [];
	const conflicts: FileChange[] = changes?.files.filter((c) => c.status === "conflict") ?? [];
	const rest = changes?.files.filter((c) => c.status !== "conflict") ?? [];
	const changed = changes?.files.map((file) => file.path) ?? [];
	// Edits are relative to the session's folder, changes to the repository, which may sit above it.
	const editedMatchesChanges =
		edited.length === changes?.total &&
		edited.every((p) => changed.some((c) => c === p || c.endsWith(`/${p}`)));
	if (!changes && !edited.length) return <Empty>No changed files.</Empty>;
	return (
		<>
			{conflicts.length > 0 && (
				<Panel attention>
					<Section title="Conflicts to resolve">
						<ul class="divide-y divide-line">
							{conflicts.map((file) => (
								<FileRow key={file.path} file={file} />
							))}
						</ul>
					</Section>
				</Panel>
			)}
			{changes && (
				<Panel>
					<Section title="Not committed yet">
						<p class="text-sm text-muted tabular-nums">
							{plural(changes.total, "file")} · <span class="text-done">+{changes.added}</span>{" "}
							<span class="text-halt">−{changes.removed}</span>
						</p>
						<ul class="divide-y divide-line">
							{rest.map((file) => (
								<FileRow key={file.path} file={file} />
							))}
						</ul>
						<More count={changes.total - changes.files.length} />
					</Section>
				</Panel>
			)}
			{edited.length > 0 && !editedMatchesChanges && (
				<Panel>
					<Section title="Edited by this session">
						<ul class="divide-y divide-line">
							{edited.map((path) => (
								<li key={path} class="break-all py-1.5 font-mono text-[13px]">
									{path}
								</li>
							))}
						</ul>
					</Section>
				</Panel>
			)}
		</>
	);
}

/** A stopped operation first, then where the branch stands, the session's commits, and the timeline. */
function Git({ session, now }: { session: SessionView; now: number }) {
	const f = session.fields;
	const git = f.git as GitSummary | undefined;
	const commits = (f.gitCommits as GitCommit[] | undefined) ?? [];
	const activity = (f.gitActivity as GitEvent[] | undefined) ?? [];
	const made = commits.filter((c) => !c.earlier);
	const rewritten = commits.filter((c) => c.earlier);
	if (!git && !activity.length) return <Empty>No git activity.</Empty>;
	return (
		<>
			{git?.busy && (
				<p class="rounded-2xl bg-lamp-soft px-4 py-3 text-sm font-medium text-lamp">
					{busyLine(git.busy)}
				</p>
			)}
			{(git?.upstream || git?.unpushed) && (
				<Panel>
					<Section title="Branch">
						<p class="text-sm">
							{[
								text(f.branch),
								git.upstream && upstreamLine(git.upstream),
								git.unpushed ? `${git.unpushed} not pushed` : undefined,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					</Section>
				</Panel>
			)}
			{git && git.commits > 0 && (
				<Panel>
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
				</Panel>
			)}
			{git && git.earlier > 0 && (
				<Panel>
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
				</Panel>
			)}
			{activity.length > 0 && (
				<Panel>
					<Section title="Git activity">
						<ul class="divide-y divide-line">
							{activity.map((event, i) => (
								<GitEventRow key={`${event.at}-${i}`} event={event} now={now} />
							))}
						</ul>
					</Section>
				</Panel>
			)}
		</>
	);
}

/** How the session runs, then where, then when. */
function Details({
	session,
	machineName,
	now,
}: {
	session: SessionView;
	machineName: string;
	now: number;
}) {
	const f = session.fields;
	return (
		<Panel>
			<Info
				rows={[
					["Model", modelName(text(f.model))],
					["Mode", label(MODE_LABELS, f.mode)],
					["Effort", text(f.effort)],
					["Branch", text(f.branch)],
					["Folder", text(f.cwd)],
					["Computer", machineName],
					["Started", label(START_LABELS, f.startedFrom)],
					["Opened", clockTime(session.startedAt, now)],
					["Last update", `${formatDuration(now - session.updatedAt)} ago`],
				]}
			/>
		</Panel>
	);
}

/** One part of a session on its own screen, kept live like the overview. */
export function SessionSection({
	section,
	session,
	machineName,
	now,
}: {
	section: SectionName;
	session: SessionView;
	machineName: string;
	now: number;
}) {
	return (
		<>
			<ScreenHeader
				title={TITLES[section]}
				subtitle={sessionTitle(session)}
				backLabel="Back to the session"
			/>
			<div class="mt-6 space-y-4">
				{section === "conversation" && <Conversation session={session} />}
				{section === "activity" && <Activity session={session} now={now} />}
				{section === "files" && <Files session={session} />}
				{section === "git" && <Git session={session} now={now} />}
				{section === "details" && <Details session={session} machineName={machineName} now={now} />}
			</div>
		</>
	);
}
