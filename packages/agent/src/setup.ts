import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Config, loadConfig } from "./config.ts";
import { lookoutHome, paths } from "./home.ts";
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
 * Put the CLI somewhere stable for the hooks to call. A bundled build copies itself into
 * ~/.claude-lookout/app so `npx` cache cleanups can't break anything; running from source
 * points the hooks at the source file.
 */
function entryPath(): string {
	const running = process.argv[1];
	if (!running) throw new Error("cannot tell where claude-lookout is running from");
	if (running.endsWith(".ts")) return running;
	return join(lookoutHome(), "app", "claude-lookout.js");
}

function installEntry(): string {
	const target = entryPath();
	const running = process.argv[1] as string;
	if (running === target || running.endsWith(".ts")) return target;
	mkdirSync(dirname(target), { recursive: true });
	// Hooks may start the CLI at any moment, so they must never find it half-copied.
	const tmp = `${target}.tmp`;
	copyFileSync(running, tmp);
	renameSync(tmp, target);
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
	prepare: () => void = () => {},
): Promise<boolean> {
	for (;;) {
		const shown = readSettingsText(path);
		const current = parseSettings(path, shown);
		const before = shown ? `${JSON.stringify(current, null, 2)}\n` : "";
		const after = `${JSON.stringify(change(current), null, 2)}\n`;
		if (before === after) {
			prepare();
			console.log(`${path} is already up to date.`);
			return true;
		}
		console.log(`\nChanges to ${path}:\n${lineDiff(before, after)}\n`);
		if (!(await confirm("Apply these changes?", yes))) return false;
		if (readSettingsText(path) !== shown) {
			console.log(`${path} changed in the meantime; here is the change again.`);
			continue;
		}
		prepare();
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

export async function runSetup(options: SetupOptions): Promise<void> {
	const config = loadConfig();
	const entry = entryPath();
	const node = nodeOnPath();
	const settingsPath = claudeSettingsPath();
	const applied = await writeSettings(
		settingsPath,
		(current) => withLookoutHooks(current, node, entry),
		options.yes,
		() => {
			saveConfig(config);
			installEntry();
		},
	);
	if (!applied) {
		console.log("Setup stopped; nothing in Claude Code's settings was changed.");
		return;
	}
	console.log(
		`\nclaude-lookout is set up on ${config.machine.name}.` +
			"\nIt starts by itself with your next Claude Code session; nothing needs to keep running." +
			"\nSessions that are already open may need a restart to be picked up." +
			"\nCheck it any time with: claude-lookout status",
	);
}

export async function runUninstall(options: SetupOptions): Promise<void> {
	const settingsPath = claudeSettingsPath();
	if (await writeSettings(settingsPath, withoutLookoutHooks, options.yes)) {
		console.log(
			`\nclaude-lookout's hooks are removed. Its config remains in ${lookoutHome()};` +
				" delete that folder to remove them too.",
		);
	}
}
