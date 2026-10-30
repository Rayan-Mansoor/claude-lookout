import {
	type FileChange,
	formatDuration,
	type GitCommit,
	type GitEvent,
	type GitSummary,
	type SessionView,
	type Step,
	type Subagent,
	type TaskProgress,
	type WorkingChanges,
} from "@claude-lookout/protocol";
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
	Rows,
	ScreenHeader,
	Section,
	StepList,
	Strip,
	UnpushedMark,
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
			{prompt && (
				<Section title="Your last prompt">
					<Block>{prompt}</Block>
				</Section>
			)}
		</>
	);
}

function TaskBar({ tasks }: { tasks: TaskProgress }) {
	return (
		<div class="h-1.5 overflow-hidden rounded-full bg-surface-2">
			<div
				class="h-full rounded-full bg-working transition-[width] duration-300"
				style={{ width: `${(tasks.done / tasks.total) * 100}%` }}
			/>
		</div>
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
				<Section title={session.state === "permission" ? "Waiting to run" : "Running now"}>
					<p class="break-words font-mono text-mono">{describeStep(step, now)}</p>
					<p class="text-meta text-muted">
						for {formatDuration(now - step.at)} · since {clockTime(step.at, now)}
					</p>
				</Section>
			)}
			{tasks && tasks.total > 0 && (
				<Section
					title="Tasks"
					aside={
						<span class="font-mono">
							{tasks.done} of {tasks.total}
						</span>
					}
				>
					<TaskBar tasks={tasks} />
					{tasks.current && <p class="text-[0.875rem]">{tasks.current}</p>}
				</Section>
			)}
			{subagents.length > 0 && (
				<Section title="Subagents running">
					<p class="text-[0.875rem]">{subagents.map((a) => a.type).join(", ")}</p>
				</Section>
			)}
			{steps.length > 0 && (
				<Section title="Recent steps">
					<StepList session={session} now={now} />
				</Section>
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
				<Section title="Conflicts to resolve" tone="text-lamp">
					<Rows>
						{conflicts.map((file) => (
							<FileRow key={file.path} file={file} />
						))}
					</Rows>
				</Section>
			)}
			{changes && rest.length > 0 && (
				<Section
					title="Not committed yet"
					aside={
						<span class="font-mono">
							{plural(changes.total, "file")} <span class="text-done">+{changes.added}</span>{" "}
							<span class="text-halt">−{changes.removed}</span>
						</span>
					}
				>
					<Rows>
						{rest.map((file) => (
							<FileRow key={file.path} file={file} />
						))}
					</Rows>
					<More count={changes.total - changes.files.length} />
				</Section>
			)}
			{edited.length > 0 && !editedMatchesChanges && (
				<Section title="Edited by this session">
					<Rows>
						{edited.map((path) => (
							<li key={path} class="break-all py-2 font-mono text-mono">
								{path}
							</li>
						))}
					</Rows>
				</Section>
			)}
		</>
	);
}

function CommitList({ commits, total }: { commits: GitCommit[]; total: number }) {
	if (commits.length === 0) return <p class="text-[0.875rem]">{plural(total, "commit")}</p>;
	return (
		<>
			<Rows>
				{commits.map((commit) => (
					<CommitRow key={commit.sha} commit={commit} />
				))}
			</Rows>
			<More count={total - commits.length} />
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
	const branch = text(f.branch);
	return (
		<>
			{git?.busy && (
				<Strip tone="lamp">
					<span class="font-semibold">{busyLine(git.busy)}</span>
				</Strip>
			)}
			{(git?.upstream || git?.unpushed || branch) && (
				<Section title="Branch">
					<p class="text-[0.875rem]">
						{branch && <span class="font-mono">{branch}</span>}
						{git?.upstream && (
							<>
								{branch && " · "}
								{upstreamLine(git.upstream)}
							</>
						)}
						{git?.unpushed ? <span class="text-lamp"> · {git.unpushed} not pushed</span> : null}
					</p>
				</Section>
			)}
			{git && git.commits > 0 && (
				<Section title="Commits this session">
					<CommitList commits={made} total={git.commits} />
				</Section>
			)}
			{git && git.earlier > 0 && (
				<Section title="Earlier commits rewritten">
					<CommitList commits={rewritten} total={git.earlier} />
				</Section>
			)}
			{commits.some((c) => c.unpushed) && (
				<p class="flex items-center gap-2 text-meta text-muted">
					<UnpushedMark /> not pushed
				</p>
			)}
			{activity.length > 0 && (
				<Section title="Activity">
					<Rows>
						{activity.map((event, i) => (
							<GitEventRow key={`${event.at}-${i}`} event={event} now={now} />
						))}
					</Rows>
				</Section>
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
			<div class="mt-6 space-y-7">
				{section === "conversation" && <Conversation session={session} />}
				{section === "activity" && <Activity session={session} now={now} />}
				{section === "files" && <Files session={session} />}
				{section === "git" && <Git session={session} now={now} />}
				{section === "details" && <Details session={session} machineName={machineName} now={now} />}
			</div>
		</>
	);
}
