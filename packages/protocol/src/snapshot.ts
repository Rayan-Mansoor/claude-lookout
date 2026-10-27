import { fieldLevel, type Level, visibleFields } from "./fields.ts";
import { clip } from "./redact.ts";
import type { Session, SessionState } from "./session.ts";

/** Bumped whenever the snapshot shape changes in a way older viewers can't read. */
export const PROTOCOL_VERSION = 1;

/** The most a snapshot may weigh in bytes before sealing, so it always fits under a relay's limit. */
const SNAPSHOT_BUDGET = 1_000_000;

/** What texts shrink to when a snapshot runs over budget. */
const SHRUNK_TEXT = 4000;

/** A session as a viewer sees it: state plus the fields allowed by the exposure level. */
export interface SessionView {
	id: string;
	state: SessionState;
	since: number;
	startedAt: number;
	updatedAt: number;
	fields: Record<string, unknown>;
}

export interface Machine {
	id: string;
	name: string;
}

/** Everything one machine reports at a moment in time. */
export interface Snapshot {
	v: typeof PROTOCOL_VERSION;
	machine: Machine;
	sentAt: number;
	sessions: SessionView[];
}

export function toView(session: Session, maxLevel: Level): SessionView {
	return {
		id: session.id,
		state: session.state,
		since: session.since,
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		fields: visibleFields(session.fields, maxLevel),
	};
}

function byteSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Shorten every long text inside a field value. */
function shrink(value: unknown): unknown {
	if (typeof value === "string") return clip(value, SHRUNK_TEXT);
	if (Array.isArray(value)) return value.map(shrink);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
	}
	return value;
}

/** Keep only the fields that say where a session stands (level 1). */
function essentials(fields: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([key]) => fieldLevel(key) === 1));
}

/**
 * Everything one machine reports, newest session first. Texts are kept whole; only when the
 * snapshot would run over budget are the least recently updated sessions cut back first: their
 * texts shortened, then their content dropped, then closed sessions left out. However much there
 * is, the snapshot always fits, so the machine never drops off the dashboard.
 */
export function buildSnapshot(
	machine: Machine,
	sessions: Iterable<Session>,
	maxLevel: Level,
	now: number,
): Snapshot {
	const views = [...sessions].map((s) => toView(s, maxLevel));
	views.sort((a, b) => b.updatedAt - a.updatedAt);
	const snapshot: Snapshot = { v: PROTOCOL_VERSION, machine, sentAt: now, sessions: views };
	// Sizes are tracked per session, so even thousands of sessions are cut back quickly.
	const sizes = views.map(byteSize);
	let total = byteSize({ ...snapshot, sessions: [] }) + sizes.reduce((sum, n) => sum + n + 1, 0);
	const cuts = [
		(view: SessionView) => shrink(view.fields) as Record<string, unknown>,
		(view: SessionView) => essentials(view.fields),
		() => ({}),
	];
	for (const cut of cuts) {
		for (let i = views.length - 1; i >= 0 && total > SNAPSHOT_BUDGET; i--) {
			const view = views[i] as SessionView;
			view.fields = cut(view);
			const size = byteSize(view);
			total += size - (sizes[i] as number);
			sizes[i] = size;
		}
	}
	// Last resort: leave out the oldest sessions, closed ones first.
	while (total > SNAPSHOT_BUDGET && views.length > 0) {
		const closed = views.findLastIndex((view) => view.state === "gone");
		const i = closed >= 0 ? closed : views.length - 1;
		total -= (sizes[i] as number) + 1;
		views.splice(i, 1);
		sizes.splice(i, 1);
	}
	return snapshot;
}
