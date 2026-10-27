import { execFile } from "node:child_process";
import {
	NOTIFY_STATES,
	type Notice,
	type NotifyResult,
	noticeFor,
	type Session,
	toView,
} from "@claude-lookout/protocol";
import type { Agent } from "./agent.ts";
import type { Publisher } from "./transport/publisher.ts";

/**
 * How long a session must stay blocked or finished before a notification goes out, so a prompt
 * answered at the keyboard doesn't also buzz the phone.
 */
export const NOTIFY_DELAY_MS = Number(process.env.CLAUDE_LOOKOUT_NOTIFY_DELAY_MS ?? 10_000);

/** Whether this Mac's lid is shut, so nobody is at the keyboard to answer first. */
export function lidClosed(): Promise<boolean> {
	if (process.platform !== "darwin") return Promise.resolve(false);
	return new Promise((resolve) => {
		execFile(
			"/usr/sbin/ioreg",
			["-r", "-k", "AppleClamshellState", "-d", "1"],
			{ timeout: 2000 },
			(err, stdout) => resolve(!err && /"AppleClamshellState" = Yes/.test(stdout)),
		);
	});
}

/** One log line per notification, so a missed one can be explained. */
export function describeDelivery(notice: Notice, result: NotifyResult): string {
	if (result.devices === 0) return `no devices have notifications on: ${notice.title}`;
	const line = `notified ${result.delivered}/${result.devices} devices: ${notice.title}`;
	return result.failures.length > 0
		? `${line} (push service answered ${result.failures.join(", ")})`
		: line;
}

/** When a notification that didn't go out is tried again (the network may be waking up too). */
export const RETRY_MS = [5_000, 20_000, 60_000];

export interface NotifierOptions {
	/** Skips the wait when it resolves true; nobody can answer at the keyboard first. */
	lidClosed?: () => Promise<boolean>;
}

/** Turn state changes into push notifications, once per state entry. */
export function startNotifier(
	agent: Agent,
	publisher: Publisher,
	log: (message: string) => void,
	options: NotifierOptions = {},
): void {
	const isLidClosed = options.lidClosed ?? lidClosed;
	const pending = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();

	const cancel = (id: string) => {
		clearTimeout(pending.get(id)?.timer);
		pending.delete(id);
	};

	agent.onTransition((session: Session) => {
		cancel(session.id);
		if (!NOTIFY_STATES.includes(session.state)) return;

		const { id, state, since } = session;
		const entry: { timer?: ReturnType<typeof setTimeout> } = {};
		pending.set(id, entry);
		void isLidClosed().then((closed) => {
			if (pending.get(id) !== entry) return;
			entry.timer = setTimeout(
				() => {
					pending.delete(id);
					const current = agent.sessions.get(id);
					if (!current || current.state !== state || current.since !== since) return;
					const notice = noticeFor(toView(current, agent.config.level), agent.config.machine.name);
					if (!notice) return;
					const still = () => {
						const latest = agent.sessions.get(id);
						return latest?.state === state && latest.since === since;
					};
					const attempt = (n: number): Promise<void> =>
						publisher
							.notify(notice)
							.then((result) => log(describeDelivery(notice, result)))
							.catch(async (err: Error) => {
								const wait = RETRY_MS[n];
								if (wait === undefined) {
									log(`notification failed: ${err.message}`);
									return;
								}
								log(`notification failed, trying again in ${wait / 1000}s: ${err.message}`);
								await new Promise((resolve) => setTimeout(resolve, wait));
								// Only while it still says something true.
								if (still()) await attempt(n + 1);
							});
					void attempt(0);
				},
				closed ? 0 : NOTIFY_DELAY_MS,
			);
		});
	});
}
