import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { DEFAULT_LEVEL, type Level, type Machine } from "@claude-lookout/protocol";
import { paths } from "./home.ts";

export interface Config {
	machine: Machine;
	/** Highest field level that leaves this machine. */
	level: Level;
}

export function defaultConfig(): Config {
	return {
		machine: { id: randomUUID(), name: hostname().replace(/\.local$/, "") },
		level: DEFAULT_LEVEL,
	};
}

/**
 * This machine's config, or a fresh one when there is none yet. A config that can't be read is
 * an error, never silently replaced by a fresh one.
 */
export function loadConfig(path = paths.config()): Config {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
		throw new Error(`Can't read ${path}: ${(err as Error).message}`);
	}
	let saved: unknown;
	try {
		saved = JSON.parse(text);
	} catch {
		saved = undefined;
	}
	if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
		throw new Error(`${path} is damaged. Fix it, or move it away to start over with a new one.`);
	}
	return { ...defaultConfig(), ...saved };
}
