import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import type { Session } from "@claude-lookout/protocol";
import { Agent } from "./agent.ts";
import { type Config, loadConfig } from "./config.ts";
import { gitBranch } from "./git.ts";
import { lookoutHome, paths } from "./home.ts";
import type { Request } from "./ipc.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { ProgressTracker } from "./progress.ts";
import { followTranscripts, TranscriptReader } from "./transcript.ts";
import { directPublisher } from "./transport/direct.ts";
import { throttled } from "./transport/publisher.ts";
import { checkSessions, findClaudePid } from "./watch.ts";

/** How long the agent lingers once every Claude Code session has closed. */
const IDLE_MS = Number(process.env.CLAUDE_LOOKOUT_IDLE_MS ?? 5 * 60_000);
const TICK_MS = Math.min(30_000, IDLE_MS);
/** How often open sessions are checked for interrupts and closed terminals. */
const WATCH_MS = 2000;

export function log(message: string): void {
	console.log(`${new Date().toISOString()} ${message}`);
}

function quietUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}

/** Write a file whole or not at all, logging instead of failing when the disk refuses. */
function saveFile(path: string, content: string): void {
	try {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, content, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		log(`could not save ${path}: ${(err as Error).message}`);
	}
}

function loadSessions(agent: Agent): void {
	try {
		const saved = JSON.parse(readFileSync(paths.sessions(), "utf8")) as Session[];
		for (const s of saved) agent.sessions.set(s.id, s);
	} catch {}
}

function serve(agent: Agent): Server {
	return createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				try {
					const message = JSON.parse(line) as Request;
					if (message.type === "event") agent.handle(message.event);
					else if (message.type === "snapshot")
						socket.write(`${JSON.stringify(agent.snapshot())}\n`);
				} catch (err) {
					log(`bad request: ${(err as Error).message}`);
				}
			}
		});
		socket.on("end", () => socket.end());
		socket.on("error", () => {});
	});
}

/** Read the config, or say why the agent can't run. */
function readConfig(): Config | undefined {
	if (!existsSync(paths.config())) {
		log("not set up yet; run `npx claude-lookout setup`");
		return undefined;
	}
	try {
		return loadConfig();
	} catch (err) {
		log((err as Error).message);
		return undefined;
	}
}

/** Run the agent until every Claude Code session has been closed for a while. */
export async function runDaemon(): Promise<void> {
	mkdirSync(lookoutHome(), { recursive: true, mode: 0o700 });
	if (!acquireLock(paths.lock())) return;

	// Until the agent is up, stopping only has the lock to give back.
	let shutdown: (reason: string) => void = (reason) => {
		log(`agent ${process.pid} stopping: ${reason}`);
		releaseLock(paths.lock());
		process.exit(0);
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	// A bug in one part must not take the dashboard down, nor leave a lock and socket behind.
	process.on("uncaughtException", (err) => log(`unexpected error: ${err.stack ?? err.message}`));
	process.on("unhandledRejection", (err) =>
		log(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
	);

	const config = readConfig();
	if (!config) {
		shutdown("no usable config");
		return;
	}
	const agent = new Agent(config, { gitBranch }, Date.now, findClaudePid);
	loadSessions(agent);

	const publisher = await directPublisher(config.transport, config.space, log);
	const publish = throttled(publisher, 250, (err) => log(`publish failed: ${err.message}`));
	agent.onChange((snapshot) => publish(snapshot, config.machine.id));
	new ProgressTracker(agent).start();
	publish(agent.snapshot(), config.machine.id);

	const saveSessions = () =>
		saveFile(paths.sessions(), JSON.stringify([...agent.sessions.values()]));
	let saveTimer: NodeJS.Timeout | undefined;
	agent.onChange(() => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(saveSessions, 250);
	});

	quietUnlink(paths.socket());

	let stopping = false;
	shutdown = (reason: string) => {
		if (stopping) return;
		stopping = true;
		log(`agent ${process.pid} stopping: ${reason}`);
		clearTimeout(saveTimer);
		saveSessions();
		server.close();
		publisher.stop();
		quietUnlink(paths.socket());
		releaseLock(paths.lock());
		process.exit(0);
	};

	const server = serve(agent);
	server.on("error", (err) => void shutdown(`socket error: ${err.message}`));
	server.listen(paths.socket(), () => {
		chmodSync(paths.socket(), 0o600);
		log(`agent ${process.pid} listening`);
	});

	setInterval(() => {
		agent.prune();
		if (agent.idle() && Date.now() - agent.lastEventAt > IDLE_MS) void shutdown("no open sessions");
	}, TICK_MS);

	const transcripts = new TranscriptReader();
	setInterval(() => {
		for (const session of checkSessions(agent.sessions.values(), Date.now())) agent.update(session);
		followTranscripts(agent, transcripts);
	}, WATCH_MS);
}
