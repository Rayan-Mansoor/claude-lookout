#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { paths } from "./home.ts";
import { runHook } from "./hook.ts";
import { fetchSnapshot } from "./ipc.ts";
import { printViewLink, runSetup, runUninstall } from "./setup.ts";
import { renderStatus } from "./status.ts";

const HELP = `claude-lookout: see what your Claude Code sessions are doing

Usage:
  claude-lookout setup       Connect claude-lookout to Claude Code (once per machine)
  claude-lookout status      Show the sessions open on this machine
  claude-lookout link        Show the view link and QR code again
  claude-lookout uninstall   Disconnect claude-lookout from Claude Code

Setup options:
  --yes                      Apply settings changes without asking
  --host <address>           Where the dashboard listens (default 127.0.0.1)
  --port <number>            Dashboard port (default 4777)
  --url <address>            The address other devices use to reach the dashboard

Used by Claude Code:
  claude-lookout hook        Read a hook event on stdin and pass it to the agent
  claude-lookout agent       Run the agent (started automatically by the hook)`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	strict: false,
	options: {
		yes: { type: "boolean" },
		host: { type: "string" },
		port: { type: "string" },
		url: { type: "string" },
	},
});
const [command] = positionals;
const option = (name: string) => (typeof values[name] === "string" ? values[name] : undefined);

switch (command) {
	case "hook":
		await runHook();
		break;
	case "agent":
		await runDaemon();
		break;
	case "setup": {
		const port = option("port");
		const host = option("host");
		const url = option("url");
		try {
			await runSetup({
				yes: values.yes === true,
				...(host ? { host } : {}),
				...(port ? { port: Number(port) } : {}),
				...(url ? { url } : {}),
			});
		} catch (err) {
			console.error((err as Error).message);
			process.exitCode = 1;
		}
		break;
	}
	case "uninstall":
		try {
			await runUninstall({ yes: values.yes === true });
		} catch (err) {
			console.error((err as Error).message);
			process.exitCode = 1;
		}
		break;
	case "status":
		console.log(renderStatus(await fetchSnapshot()));
		break;
	case "link":
		if (!existsSync(paths.config())) {
			console.log("claude-lookout isn't set up yet. Run: npx claude-lookout setup");
			process.exitCode = 1;
			break;
		}
		try {
			await printViewLink(loadConfig());
		} catch (err) {
			console.error((err as Error).message);
			process.exitCode = 1;
		}
		break;
	default:
		console.log(HELP);
		process.exitCode = command && command !== "help" ? 1 : 0;
}
