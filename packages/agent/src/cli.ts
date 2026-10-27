#!/usr/bin/env node
import { runDaemon } from "./daemon.ts";
import { runHook } from "./hook.ts";
import { fetchSnapshot } from "./ipc.ts";
import { renderStatus } from "./status.ts";

const HELP = `claude-lookout: see what your Claude Code sessions are doing

Usage:
  claude-lookout status   Show the sessions open on this machine

Used by Claude Code:
  claude-lookout hook     Read a hook event on stdin and pass it to the agent
  claude-lookout agent    Run the agent (started automatically by the hook)`;

const [command] = process.argv.slice(2);

switch (command) {
	case "hook":
		await runHook();
		break;
	case "agent":
		runDaemon();
		break;
	case "status":
		console.log(renderStatus(await fetchSnapshot()));
		break;
	default:
		console.log(HELP);
		process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
}
