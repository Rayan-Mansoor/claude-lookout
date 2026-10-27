import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { type HookEvent, isHookInput } from "@claude-lookout/protocol";
import { lookoutHome, paths } from "./home.ts";
import { request } from "./ipc.ts";

async function readStdin(): Promise<string> {
	let data = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) data += chunk;
	return data;
}

/** Start the agent in the background, detached from this short-lived hook process. */
export function startAgent(): void {
	mkdirSync(lookoutHome(), { recursive: true, mode: 0o700 });
	const log = openSync(paths.log(), "a");
	const script = process.argv[1];
	if (!script) return;
	spawn(process.execPath, [...process.execArgv, script, "agent"], {
		detached: true,
		stdio: ["ignore", log, log],
	}).unref();
}

/**
 * Called by Claude Code for every subscribed hook event. Forwards the event to the agent,
 * starting the agent first if it isn't running. Never fails: a broken monitor must not
 * disturb Claude Code.
 */
export async function runHook(): Promise<void> {
	let input: unknown;
	try {
		input = JSON.parse(await readStdin());
	} catch {
		return;
	}
	if (!isHookInput(input)) return;
	const event: HookEvent = { input, pid: process.ppid, at: Date.now() };

	try {
		await request({ type: "event", event });
		return;
	} catch {}

	startAgent();
	for (let attempt = 1; attempt <= 30; attempt++) {
		await wait(100);
		// An agent that was just stopping held the lock a moment longer; start one again then.
		if (attempt % 10 === 0) startAgent();
		try {
			await request({ type: "event", event });
			return;
		} catch {}
	}
}
