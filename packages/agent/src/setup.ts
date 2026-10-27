import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import QRCode from "qrcode";
import {
	type Config,
	DEFAULT_PORT,
	type DirectTransport,
	joinCode,
	loadConfig,
	parseJoinCode,
	viewLink,
} from "./config.ts";
import { lookoutHome, paths } from "./home.ts";
import { startAgent } from "./hook.ts";
import { isAgentProcess, lockHolder } from "./lock.ts";
import {
	claudeSettingsPath,
	lineDiff,
	type Settings,
	withLookoutHooks,
	withoutLookoutHooks,
} from "./settings.ts";

export interface SetupOptions {
	/** Apply without asking. */
	yes: boolean;
	/** Interface the dashboard listens on, e.g. 0.0.0.0 to reach it over Tailscale or the LAN. */
	host?: string;
	port?: number;
	/** The address viewers use, when it differs from host:port. */
	url?: string;
	/** Publish through the relay at this address instead of serving the dashboard locally. */
	relay?: string;
	/** The key the relay's owner set, if any. */
	relayKey?: string;
	/** Report into an existing space, using the code another machine's setup printed. */
	join?: string;
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
	if (yes) return true;
	if (!process.stdin.isTTY) {
		console.log(`${question} Run again with --yes to confirm without a prompt.`);
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(`${question} [y/N] `);
	rl.close();
	return /^y(es)?$/i.test(answer.trim());
}

/** Folders a version manager creates for one shell only, gone once that shell closes. */
const PER_SHELL_DIRS = /[/\\](fnm_multishells|\.volta[/\\]tmp)[/\\]/;

/** The `node` Claude Code should run: the one on PATH, so Node upgrades don't break the hooks. */
export function nodeOnPath(path = process.env.PATH ?? ""): string {
	for (const dir of path.split(delimiter)) {
		const candidate = join(dir, "node");
		if (!dir || !existsSync(candidate)) continue;
		// A link that only lives as long as this shell would break every hook once it closes.
		return PER_SHELL_DIRS.test(candidate) ? realpathSync(candidate) : candidate;
	}
	return process.execPath;
}

/**
 * Put the CLI somewhere stable for the hooks to call. A bundled build copies itself and the
 * dashboard into ~/.claude-lookout/app so `npx` cache cleanups can't break anything; running
 * from source points the hooks at the source file.
 */
/** The file this CLI runs from; `npx` starts it through a link in node_modules/.bin. */
function runningFile(started: string | undefined): string {
	if (!started) throw new Error("cannot tell where claude-lookout is running from");
	return realpathSync(started);
}

/** Where the hooks run the CLI from: the installed copy, or the source file when run from source. */
export function entryPath(started = process.argv[1]): string {
	const running = runningFile(started);
	return running.endsWith(".ts") ? running : join(lookoutHome(), "app", "claude-lookout.js");
}

export function installEntry(started = process.argv[1]): string {
	// The dashboard sits by the real file.
	const running = runningFile(started);
	if (running.endsWith(".ts")) return running;
	const appDir = join(lookoutHome(), "app");
	mkdirSync(appDir, { recursive: true });
	const target = join(appDir, "claude-lookout.js");
	// Already running the installed copy (e.g. setup run again from the hooks' path).
	const installed = join(realpathSync(appDir), "claude-lookout.js");
	if (running !== installed) {
		// Hooks may start the CLI at any moment, so they must never find it half-copied.
		const tmp = `${target}.tmp`;
		copyFileSync(running, tmp);
		renameSync(tmp, target);
		const web = join(dirname(running), "web");
		if (existsSync(join(web, "index.html"))) {
			rmSync(join(appDir, "web"), { recursive: true, force: true });
			cpSync(web, join(appDir, "web"), { recursive: true });
		} else {
			// Never leave the machine without a dashboard because this build lacks one.
			console.warn(
				`No dashboard files next to ${running}; kept the installed dashboard. ` +
					"Run `npm run build` in the repository, then setup again.",
			);
		}
	}
	return target;
}

/** The settings file as text, or "" when there is none. */
function readSettingsText(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseSettings(path: string, text: string): Settings {
	if (!text) return {};
	try {
		return JSON.parse(text) as Settings;
	} catch {
		throw new Error(`${path} isn't valid JSON. Fix it, then run this again.`);
	}
}

/**
 * Show the change, ask, back up the old file, then write the new one atomically. `prepare` runs
 * once you agreed, before the file is written. A file that is a link is written through, and keeps
 * its permissions. If the file changed while you were reading, the new change is shown again.
 */
export async function writeSettings(
	path: string,
	change: (current: Settings) => Settings,
	yes: boolean,
	prepare: () => void | Promise<void> = () => {},
): Promise<boolean> {
	for (;;) {
		const shown = readSettingsText(path);
		const current = parseSettings(path, shown);
		const before = shown ? `${JSON.stringify(current, null, 2)}\n` : "";
		const after = `${JSON.stringify(change(current), null, 2)}\n`;
		if (before === after) {
			await prepare();
			console.log(`${path} is already up to date.`);
			return true;
		}
		console.log(`\nChanges to ${path}:\n${lineDiff(before, after)}\n`);
		if (!(await confirm("Apply these changes?", yes))) return false;
		if (readSettingsText(path) !== shown) {
			console.log(`${path} changed in the meantime; here is the change again.`);
			continue;
		}
		await prepare();
		const target = shown ? realpathSync(path) : path;
		mkdirSync(dirname(target), { recursive: true });
		if (shown) {
			const backup = `${path}.claude-lookout-backup-${Date.now()}`;
			copyFileSync(target, backup);
			console.log(`Backed up the previous file to ${backup}`);
		}
		const tmp = `${target}.claude-lookout-tmp`;
		writeFileSync(tmp, after);
		if (shown) chmodSync(tmp, statSync(target).mode & 0o7777);
		renameSync(tmp, target);
		return true;
	}
}

function saveConfig(config: Config): void {
	mkdirSync(lookoutHome(), { recursive: true, mode: 0o700 });
	writeFileSync(paths.config(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Stop a running agent and wait for it to finish, so a new one can start with the new config
 * and code. Returns whether one was running.
 */
async function stopAgent(): Promise<boolean> {
	// Only ever an agent: a lock left by one that died may name a pid now used by another program.
	const pid = lockHolder(paths.lock());
	if (!pid || !isAgentProcess(pid)) return false;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	for (let i = 0; i < 50 && existsSync(paths.lock()); i++) await wait(100);
	return true;
}

/** Print the view link and a QR code for phones. */
export async function printViewLink(config: Config): Promise<void> {
	const link = viewLink(config);
	console.log(`\nView link (anyone with it can see your sessions):\n\n  ${link}\n`);
	console.log(await QRCode.toString(link, { type: "terminal", small: true }));
	if (config.transport.mode === "direct" && !config.transport.publicUrl) {
		console.log(
			"The dashboard is served from this machine while Claude Code runs." +
				"\nTo open it from other devices, see Hosting in the README.",
		);
	}
	const join = joinCode(config);
	if (join) {
		console.log(
			"To show another computer's sessions on the same dashboard, run this there" +
				" (keep it private: it lets that computer publish):" +
				`\n\n  npx claude-lookout setup --join ${join}\n`,
		);
	}
}

/** The config after this run's options: join a space, switch to a relay, or tune Direct mode. */
export function applyOptions(config: Config, options: SetupOptions): Config {
	if (options.join) {
		const joined = parseJoinCode(options.join);
		if (!joined)
			throw new Error("That join code isn't valid. Copy it again from the other computer.");
		return { ...config, ...joined };
	}
	if (options.relay) {
		const url = options.relay.replace(/\/+$/, "");
		return {
			...config,
			transport: { mode: "relay", url, ...(options.relayKey ? { key: options.relayKey } : {}) },
		};
	}
	if (options.relayKey && config.transport.mode === "relay") {
		return { ...config, transport: { ...config.transport, key: options.relayKey } };
	}
	if (!options.host && !options.port && !options.url) return config;
	const direct: DirectTransport =
		config.transport.mode === "direct"
			? config.transport
			: { mode: "direct", host: "127.0.0.1", port: DEFAULT_PORT };
	return {
		...config,
		transport: {
			...direct,
			...(options.host ? { host: options.host } : {}),
			...(options.port ? { port: options.port } : {}),
			...(options.url ? { publicUrl: options.url } : {}),
		},
	};
}

export async function runSetup(options: SetupOptions): Promise<void> {
	const config = applyOptions(loadConfig(), options);
	const entry = entryPath();
	const node = nodeOnPath();
	const settingsPath = claudeSettingsPath();
	const applied = await writeSettings(
		settingsPath,
		(current) => withLookoutHooks(current, node, entry),
		options.yes,
		async () => {
			saveConfig(config);
			await stopAgent();
			installEntry();
		},
	);
	if (!applied) {
		console.log("Setup stopped; nothing in Claude Code's settings was changed.");
		return;
	}
	// Start right away rather than on the next hook, so the dashboard is back for sessions
	// that are open but idle. With nothing open, it stops again after a few minutes.
	startAgent(entry);
	console.log(
		`\nclaude-lookout is set up on ${config.machine.name}.` +
			"\nIt starts by itself with your next Claude Code session; nothing needs to keep running." +
			"\nSessions that are already open may need a restart to be picked up." +
			"\nCheck it any time with: claude-lookout status",
	);
	await printViewLink(config);
}

export async function runUninstall(options: SetupOptions): Promise<void> {
	const settingsPath = claudeSettingsPath();
	if (await writeSettings(settingsPath, withoutLookoutHooks, options.yes)) {
		console.log(
			`\nclaude-lookout's hooks are removed. Its config and view link remain in ${lookoutHome()};` +
				" delete that folder to remove them too.",
		);
	}
}
