import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Where claude-lookout keeps its config, state and logs. Override with CLAUDE_LOOKOUT_HOME. */
export function lookoutHome(): string {
	return process.env.CLAUDE_LOOKOUT_HOME ?? join(homedir(), ".claude-lookout");
}

export const paths = {
	config: () => join(lookoutHome(), "config.json"),
	socket: socketPath,
	lock: () => join(lookoutHome(), "agent.lock"),
	log: () => join(lookoutHome(), "agent.log"),
	sessions: () => join(lookoutHome(), "sessions.json"),
	hub: () => join(lookoutHome(), "hub.json"),
	/** Present while a state change or notification is still on its way out. */
	hold: () => join(lookoutHome(), "hold"),
};

/**
 * A folder in the temp directory only this user can enter. The temp directory may be shared with
 * other users (Linux's /tmp), who must not be able to plant a socket that receives hook events.
 */
function privateTempDir(): string | undefined {
	const { uid } = userInfo();
	const dir = join(tmpdir(), `claude-lookout-${uid}`);
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch {}
	try {
		const stat = lstatSync(dir);
		const ok = stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
		return ok ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Unix socket paths are limited to about 100 bytes; fall back to a short per-user path. */
function socketPath(): string {
	const preferred = join(lookoutHome(), "agent.sock");
	if (Buffer.byteLength(preferred) < 100) return preferred;
	const dir = privateTempDir();
	if (!dir) return preferred;
	const hash = createHash("sha256").update(lookoutHome()).digest("hex").slice(0, 12);
	return join(dir, `${hash}.sock`);
}
