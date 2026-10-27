import { useEffect, useState } from "preact/hooks";

/** Where the dashboard is: the session list, or one session's own screen. */
export type Route = { name: "list" } | { name: "session"; machine: string; session: string };

const SESSION_PATH = /^\/s\/([A-Za-z0-9-]{1,64})\/([A-Za-z0-9-]{1,128})\/?$/;

export function parseRoute(pathname: string): Route {
	const match = pathname.match(SESSION_PATH);
	return match?.[1] && match[2]
		? { name: "session", machine: match[1], session: match[2] }
		: { name: "list" };
}

export function sessionPath(machine: string, session: string): string {
	return `/s/${machine}/${session}`;
}

/** Remembered so the list reopens where you were after looking at a session. */
let listScroll = 0;
/** True when the current screen was opened from the list, so going back is a real back step. */
let openedFromList = false;

export function navigate(path: string): void {
	openedFromList = location.pathname === "/";
	if (openedFromList) listScroll = window.scrollY;
	history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Return to the list: a real back step when we came from it, otherwise replace this entry. */
export function back(): void {
	if (openedFromList) {
		history.back();
		return;
	}
	history.replaceState(null, "", "/");
	window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current route, following back and forward like any other site. */
export function useRoute(): Route {
	const [route, setRoute] = useState(() => parseRoute(location.pathname));
	useEffect(() => {
		const onChange = () => {
			const next = parseRoute(location.pathname);
			setRoute(next);
			requestAnimationFrame(() => window.scrollTo(0, next.name === "list" ? listScroll : 0));
		};
		window.addEventListener("popstate", onChange);
		return () => window.removeEventListener("popstate", onChange);
	}, []);
	return route;
}
