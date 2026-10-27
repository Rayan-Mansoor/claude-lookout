import {
	buildSnapshot,
	type FieldContext,
	type HookEvent,
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
		this.sessions.set(id, reduce(this.sessions.get(id), resolved, this.ctx));
		this.lastEventAt = this.now();
		this.changed();
	}

	/** Replace a session wholesale, e.g. after a watcher notices it ended. */
	update(session: Session): void {
		this.sessions.set(session.id, session);
		this.changed();
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

	private changed(): void {
		if (this.listeners.size === 0) return;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}
