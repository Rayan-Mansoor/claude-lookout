import {
	buildSnapshot,
	type FieldContext,
	type HookEvent,
	type HookInput,
	reduce,
	type Session,
	type Snapshot,
} from "@claude-lookout/protocol";
import type { Config } from "./config.ts";

/** How long a closed session stays on the dashboard. */
const GONE_TTL_MS = 30 * 60_000;

/** Holds every session on this machine and turns hook events into snapshots. */
export class Agent {
	readonly sessions = new Map<string, Session>();
	readonly config: Config;
	lastEventAt: number;
	private readonly ctx: FieldContext;
	private readonly now: () => number;
	private readonly resolvePid: (pid: number) => number | undefined;
	private readonly pids = new Map<number, number>();
	private readonly listeners = new Set<(snapshot: Snapshot) => void>();
	private readonly transitionListeners = new Set<(session: Session) => void>();
	private readonly eventListeners = new Set<(session: Session, input: HookInput) => void>();

	constructor(
		config: Config,
		ctx: FieldContext,
		now: () => number = Date.now,
		resolvePid: (pid: number) => number | undefined = (pid) => pid,
	) {
		this.config = config;
		this.ctx = ctx;
		this.now = now;
		this.resolvePid = resolvePid;
		this.lastEventAt = now();
	}

	handle(event: HookEvent): void {
		const id = event.input.session_id;
		const pid = event.pid === undefined ? undefined : this.claudePid(event.pid);
		const { pid: _, ...rest } = event;
		const resolved: HookEvent = pid === undefined ? rest : { ...rest, pid };
		const before = this.sessions.get(id);
		const after = reduce(before, resolved, this.ctx);
		this.sessions.set(id, after);
		this.lastEventAt = this.now();
		this.changed();
		if (before?.state !== after.state) this.transitioned(after);
		for (const listener of this.eventListeners) listener(after, event.input);
	}

	/**
	 * Set fields worked out outside the hooks, where `null` clears one. The session keeps its
	 * state and timestamps, and viewers only hear about it when something actually changed.
	 */
	setFields(id: string, values: Record<string, unknown>): void {
		const session = this.sessions.get(id);
		if (!session) return;
		const fields = { ...session.fields };
		for (const [key, value] of Object.entries(values)) {
			if (value === null) delete fields[key];
			else fields[key] = value;
		}
		if (JSON.stringify(fields) === JSON.stringify(session.fields)) return;
		this.sessions.set(id, { ...session, fields });
		this.changed();
	}

	/** Replace a session wholesale, e.g. after a watcher notices it ended. */
	update(session: Session): void {
		const before = this.sessions.get(session.id);
		this.sessions.set(session.id, session);
		this.changed();
		if (before?.state !== session.state) this.transitioned(session);
	}

	/** Found pids are kept; a lookup that failed is tried again on the next event. */
	private claudePid(hookParent: number): number | undefined {
		const known = this.pids.get(hookParent);
		if (known !== undefined) return known;
		const found = this.resolvePid(hookParent);
		if (found !== undefined) this.pids.set(hookParent, found);
		return found;
	}

	/** Drop sessions that closed long ago. */
	prune(): void {
		const cutoff = this.now() - GONE_TTL_MS;
		let removed = false;
		for (const [id, s] of this.sessions) {
			if (s.state === "gone" && s.since < cutoff) {
				this.sessions.delete(id);
				removed = true;
			}
		}
		if (removed) this.changed();
	}

	/** True when no Claude Code session on this machine is still open. */
	idle(): boolean {
		for (const s of this.sessions.values()) if (s.state !== "gone") return false;
		return true;
	}

	snapshot(): Snapshot {
		return buildSnapshot(
			this.config.machine,
			this.sessions.values(),
			this.config.level,
			this.now(),
		);
	}

	onChange(listener: (snapshot: Snapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called after each hook event, with the session as it now stands. */
	onEvent(listener: (session: Session, input: HookInput) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/** Called with the session each time it moves into a new state. */
	onTransition(listener: (session: Session) => void): () => void {
		this.transitionListeners.add(listener);
		return () => this.transitionListeners.delete(listener);
	}

	private transitioned(session: Session): void {
		for (const listener of this.transitionListeners) listener(session);
	}

	private changed(): void {
		if (this.listeners.size === 0) return;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}
