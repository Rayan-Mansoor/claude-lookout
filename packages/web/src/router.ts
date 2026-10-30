import { useEffect, useState } from "preact/hooks";

/** The parts of a session that have a screen of their own, below its overview. */
export const SECTIONS = ["conversation", "activity", "files", "git", "details"] as const;
export type Section = (typeof SECTIONS)[number];

/** Where the dashboard is: the session list, one session's overview, or one part of it. */
export type Route =
	| { name: "list" }
	| { name: "session"; machine: string; session: string; section?: Section };

const SESSION_PATH = /^\/s\/([A-Za-z0-9-]{1,64})\/([A-Za-z0-9-]{1,128})(?:\/([a-z]+))?\/?$/;

function isSection(value: string | undefined): value is Section {
	return SECTIONS.includes(value as Section);
}

export function parseRoute(pathname: string): Route {
	const match = pathname.match(SESSION_PATH);
	if (!match?.[1] || !match[2]) return { name: "list" };
	const section = match[3];
	if (section !== undefined && !isSection(section)) return { name: "list" };
	return section
		? { name: "session", machine: match[1], session: match[2], section }
		: { name: "session", machine: match[1], session: match[2] };
}

export function sessionPath(machine: string, session: string, section?: Section): string {
	return section ? `/s/${machine}/${session}/${section}` : `/s/${machine}/${session}`;
}

/** One level up: a section goes to its session's overview, an overview to the list. */
export function parentPath(pathname: string): string {
	const route = parseRoute(pathname);
	return route.name === "session" && route.section
		? sessionPath(route.machine, route.session)
		: "/";
}

/** Where each screen was scrolled to, so going back reopens it where you were. */
const scrolls = new Map<string, number>();
/** The screens `navigate` left, newest last, so going back can be a real back step. */
const trail: string[] = [];

export function navigate(path: string): void {
	scrolls.set(location.pathname, window.scrollY);
	scrolls.delete(path);
	trail.push(location.pathname);
	history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Go up one level: a real back step when we came from there, otherwise replace this entry. */
export function back(): void {
	const parent = parentPath(location.pathname);
	if (trail.at(-1) === parent) {
		history.back();
		return;
	}
	history.replaceState(null, "", parent);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current route, following back and forward like any other site. */
export function useRoute(): Route {
	const [route, setRoute] = useState(() => parseRoute(location.pathname));
	useEffect(() => {
		const onChange = () => {
			const path = location.pathname;
			if (trail.at(-1) === path) trail.pop();
			setRoute(parseRoute(path));
			requestAnimationFrame(() => window.scrollTo(0, scrolls.get(path) ?? 0));
		};
		window.addEventListener("popstate", onChange);
		return () => window.removeEventListener("popstate", onChange);
	}, []);
	return route;
}
