#!/usr/bin/env node
import { runDaemon } from "./daemon.ts";
import { runHook } from "./hook.ts";
import { fetchSnapshot } from "./ipc.ts";
import { runSetup, runUninstall } from "./setup.ts";
import { renderStatus } from "./status.ts";

const HELP = `claude-lookout: see what your Claude Code sessions are doing

Usage:
  claude-lookout setup       Connect claude-lookout to Claude Code (once per machine)
  claude-lookout status      Show the sessions open on this machine
  claude-lookout uninstall   Disconnect claude-lookout from Claude Code

Options:
  --yes                      Apply settings changes without asking

Used by Claude Code:
  claude-lookout hook        Read a hook event on stdin and pass it to the agent
  claude-lookout agent       Run the agent (started automatically by the hook)`;

const [command, ...rest] = process.argv.slice(2);
const yes = rest.includes("--yes");

switch (command) {
	case "hook":
		await runHook();
		break;
	case "agent":
		runDaemon();
		break;
	case "setup":
	case "uninstall":
		try {
			await (command === "setup" ? runSetup : runUninstall)({ yes });
		} catch (err) {
			console.error((err as Error).message);
			process.exitCode = 1;
		}
		break;
	case "status":
		console.log(renderStatus(await fetchSnapshot()));
		break;
	default:
		console.log(HELP);
		process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
}
