import type { PermissionRequest, Question } from "./fields.ts";
import { plainLine } from "./plain.ts";
import { clip } from "./redact.ts";
import type { SessionState } from "./session.ts";
import type { SessionView } from "./snapshot.ts";

/** States worth interrupting someone for. */
export const NOTIFY_STATES: readonly SessionState[] = [
	"permission",
	"question",
	"plan",
	"finished",
];

/**
 * Whether a push subscription is cancelled when its pushes show nothing: Safari's are, so a
 * push that may show nothing never goes to Apple's push service.
 */
export function penalisesSilentPush(endpoint: string): boolean {
	try {
		return new URL(endpoint).hostname.endsWith(".push.apple.com");
	} catch {
		return false;
	}
}

/** What a push notification says; sealed before it leaves the machine. */
export interface Notice {
	title: string;
	body: string;
	/** One notification per session: a newer one replaces the older. */
	tag: string;
	/**
	 * "clear" takes the session's notification away instead of showing one. Its title and body
	 * are what a device that doesn't know clears shows in its place.
	 */
	kind?: "clear";
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionName(view: SessionView): string {
	return text(view.fields.title) ?? text(view.fields.project) ?? "Claude Code";
}

/** Takes back the notification of a session that no longer needs you. */
export function clearNoticeFor(view: SessionView, machineName: string): Notice {
	return {
		kind: "clear",
		title: `${sessionName(view)} no longer needs you`,
		body: clip(`Dealt with elsewhere · ${machineName}`, 180),
		tag: view.id,
	};
}

/** The notice for a session that just entered `view.state`, or undefined if none is due. */
export function noticeFor(view: SessionView, machineName: string): Notice | undefined {
	if (!NOTIFY_STATES.includes(view.state)) return undefined;
	const f = view.fields;
	const name = sessionName(view);
	const where = ` · ${machineName}`;
	let title: string;
	let body: string | undefined;
	switch (view.state) {
		case "permission": {
			const request = f.permission as PermissionRequest | undefined;
			title = `${name} needs permission`;
			body = request && (request.target ? `${request.tool} · ${request.target}` : request.tool);
			break;
		}
		case "question":
			title = `${name} is asking you`;
			body = plainLine((f.questions as Question[] | undefined)?.[0]?.question);
			break;
		case "plan":
			title = `${name} has a plan to approve`;
			body = plainLine(text(f.plan));
			break;
		default:
			title = text(f.error) ? `${name} stopped with an error` : `${name} finished`;
			body = plainLine(text(f.error) ?? text(f.lastMessage));
	}
	return {
		title,
		body: clip(`${body ?? "Open Lookout to see more"}${where}`, 180),
		tag: view.id,
	};
}
