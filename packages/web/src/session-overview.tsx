import {
	BLOCKED_STATES,
	formatDuration,
	type SessionView,
	type Subagent,
	type TaskProgress,
} from "@claude-lookout/protocol";
import { Markdown } from "./markdown.tsx";
import { type Section as SectionName, sessionPath } from "./router.ts";
import {
	activityDigest,
	conversationDigest,
	type DigestPart,
	describeStep,
	detailsDigest,
	filesDigest,
	gitAlerts,
	gitDigest,
	plural,
	runningStep,
	sessionProject,
	sessionTitle,
	text,
} from "./session-format.ts";
import {
	Clamp,
	Digest,
	Link,
	NeedsYou,
	ScreenHeader,
	Section,
	StateLine,
	Strip,
} from "./session-parts.tsx";

/** A reply this long is shown whole on the overview; a longer one opens on the conversation screen. */
const REPLY_LINES = 25;
const UPDATE_LINES = 8;

const SECTION_LABELS: Record<SectionName, string> = {
	conversation: "Conversation",
	activity: "Activity",
	files: "Files",
	git: "Git",
	details: "Details",
};

/** Problems that won't wait: the machine is offline, the run failed, git stopped half-way. */
function Alerts({
	session,
	machineName,
	offlineFor,
}: {
	session: SessionView;
	machineName: string;
	offlineFor?: number | undefined;
}) {
	const error = text(session.fields.error);
	const git = gitAlerts(session);
	if (offlineFor === undefined && !error && !git.length) return null;
	return (
		<div class="space-y-2">
			{offlineFor !== undefined && (
				<Strip tone="muted">
					{machineName} is offline · last seen {formatDuration(offlineFor)} ago. This is the last
					known state.
				</Strip>
			)}
			{error && (
				<Strip tone="halt">
					<span class="font-semibold">Run failed</span> · {error}
				</Strip>
			)}
			{git.length > 0 && (
				<Strip tone="lamp">
					<span class="font-semibold">{git[0]}</span>
					{git.slice(1).map((alert) => ` · ${alert}`)}
				</Strip>
			)}
		</div>
	);
}

/** Claude's own words: the reply once the run ended, or its latest update while it works. */
function ClaudeSays({ session, conversation }: { session: SessionView; conversation: string }) {
	const f = session.fields;
	if (BLOCKED_STATES.includes(session.state)) return null;
	const ended = session.state === "finished" || session.state === "background";
	const reply = text(f.lastMessage);
	const update = text(f.narration);
	if (ended && reply) {
		return (
			<Section title="Claude's reply">
				<Clamp lines={REPLY_LINES} more={{ href: conversation, label: "Read full reply" }}>
					<Markdown source={reply} />
				</Clamp>
				{session.state === "background" && (
					<p class="text-meta text-muted">Claude carries on once its background tasks report.</p>
				)}
			</Section>
		);
	}
	if (update) {
		return (
			<Section title="Claude's latest update">
				<Clamp lines={UPDATE_LINES} more={{ href: conversation, label: "Read all" }}>
					<Markdown source={update} />
				</Clamp>
			</Section>
		);
	}
	if (reply) {
		return (
			<Section title="Claude's last reply">
				<Clamp lines={REPLY_LINES} more={{ href: conversation, label: "Read full reply" }}>
					<Markdown source={reply} />
				</Clamp>
			</Section>
		);
	}
	return null;
}

function Progress({ session }: { session: SessionView }) {
	const tasks = session.fields.tasks as TaskProgress | undefined;
	const subagents = (session.fields.subagents as Subagent[] | undefined) ?? [];
	if (session.state === "gone" || (!tasks?.total && !subagents.length)) return null;
	const helpers = subagents.length > 0 && (
		<p class="text-meta text-muted">{plural(subagents.length, "subagent")} running</p>
	);
	if (!tasks?.total) return helpers;
	return (
		<Section
			title="Tasks"
			aside={
				<span class="font-mono">
					{tasks.done} of {tasks.total}
				</span>
			}
		>
			<div class="h-1.5 overflow-hidden rounded-full bg-surface-2">
				<div
					class="h-full rounded-full bg-working transition-[width] duration-300"
					style={{ width: `${(tasks.done / tasks.total) * 100}%` }}
				/>
			</div>
			{tasks.current && <p class="text-[0.875rem]">{tasks.current}</p>}
			{helpers}
		</Section>
	);
}

/** One row per section, each with the line that says whether it's worth opening. */
function SectionRows({
	machineId,
	session,
	now,
}: {
	machineId: string;
	session: SessionView;
	now: number;
}) {
	const digests: [SectionName, DigestPart[] | undefined][] = [
		["conversation", conversationDigest(session, now)],
		["activity", activityDigest(session, now)],
		["files", filesDigest(session)],
		["git", gitDigest(session)],
		["details", detailsDigest(session)],
	];
	return (
		<nav class="divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
			{digests.map(
				([section, digest]) =>
					digest && (
						<Link
							key={section}
							href={sessionPath(machineId, session.id, section)}
							class="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2"
						>
							<span class="shrink-0 font-medium">{SECTION_LABELS[section]}</span>
							<span class="min-w-0 flex-1 truncate text-right text-meta text-muted">
								<Digest parts={digest} />
							</span>
							<svg viewBox="0 0 20 20" class="size-4 shrink-0 text-muted" aria-hidden="true">
								<path
									d="M7.5 4.5 13 10l-5.5 5.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.8"
								/>
							</svg>
						</Link>
					),
			)}
		</nav>
	);
}

/** One session at a glance: what's wrong, what needs you, what Claude said, and where to look next. */
export function SessionOverview({
	machineId,
	machineName,
	session,
	now,
	offlineFor,
}: {
	machineId: string;
	machineName: string;
	session: SessionView;
	now: number;
	offlineFor?: number | undefined;
}) {
	const blocked = BLOCKED_STATES.includes(session.state);
	const step = session.state === "working" ? runningStep(session) : undefined;
	const prompt = text(session.fields.prompt);

	return (
		<>
			<ScreenHeader
				title={sessionTitle(session)}
				subtitle={[sessionProject(session), machineName].filter(Boolean).join(" · ")}
				backLabel="Back to all sessions"
			/>
			<div class="mt-6 space-y-6">
				<Alerts session={session} machineName={machineName} offlineFor={offlineFor} />
				{blocked ? (
					<NeedsYou session={session} now={now} />
				) : (
					<div class="space-y-1.5">
						<StateLine session={session} now={now} />
						{step && <p class="break-words font-mono text-mono">{describeStep(step, now)}</p>}
					</div>
				)}
				<ClaudeSays
					session={session}
					conversation={sessionPath(machineId, session.id, "conversation")}
				/>
				<Progress session={session} />
				{prompt && (
					<p class="line-clamp-2 text-[0.875rem] text-muted">
						<span class="font-medium text-ink">You asked</span> · {prompt}
					</p>
				)}
				<SectionRows machineId={machineId} session={session} now={now} />
			</div>
		</>
	);
}
