import type { Sealed } from "./crypto.ts";

/**
 * The HTTP API every claude-lookout server speaks, whether it is the agent serving a dashboard
 * directly or a relay on the internet. All session content travels sealed.
 *
 *   PUT /api/spaces/:space                    register a space (SpaceRegistration)
 *   PUT /api/spaces/:space/machines/:machine  publish a sealed snapshot   (publish token)
 *   GET /api/spaces/:space/events             stream MachineUpdate events (view token)
 */

export interface SpaceRegistration {
	viewHash: string;
	publishHash: string;
	/** The key a relay's owner set to decide who may create spaces on it; never stored. */
	relayKey?: string;
}

/** One machine's latest sealed snapshot, as streamed to viewers. */
export interface MachineUpdate {
	machine: string;
	sealed: Sealed;
	receivedAt: number;
}

/** What happened to one notification: how many devices got it, and the push service's status for each that didn't (0 when unreachable). */
export interface NotifyResult {
	devices: number;
	delivered: number;
	failures: number[];
}

export const API = {
	space: (space: string) => `/api/spaces/${space}`,
	machine: (space: string, machine: string) => `/api/spaces/${space}/machines/${machine}`,
	events: (space: string) => `/api/spaces/${space}/events`,
};
