/// <reference lib="webworker" />
import { deriveSpace, type Notice, open, type Sealed } from "@claude-lookout/protocol";
import { dashboardShowsIt, optedOut, syncSubscription } from "./push-sync.ts";
import { getItem } from "./storage.ts";

declare const self: ServiceWorkerGlobalScope;

const FALLBACK: Notice = {
	title: "Claude Code needs you",
	body: "Open Lookout to see more",
	tag: "lookout",
};

/**
 * Decrypt a pushed notice with the view secret this device holds. One it can't read becomes a
 * general alert, unless it was one that only takes a notification back: then nothing at all.
 */
async function readNotice(data: PushMessageData | null): Promise<Notice | undefined> {
	let pushed: { sealed?: Sealed; quiet?: boolean } | undefined;
	try {
		pushed = data?.json() as typeof pushed;
		const secret = await getItem<string>("viewSecret");
		if (!secret || !pushed?.sealed) throw new Error("unreadable");
		const { key } = await deriveSpace(secret);
		return await open<Notice>(key, pushed.sealed);
	} catch {
		return pushed?.quiet ? undefined : FALLBACK;
	}
}

/**
 * A copy of the dashboard kept on the device, so it opens even when the computer or relay
 * can't be reached; it then shows what each machine last reported.
 */
const SHELL_CACHE = "lookout-shell-v1";
const SHELL_PAGE = "/";

/** Scripts and styles named after their content: a new build gets new names. */
const HASHED = /^\/assets\//;

/** The scripts, styles and icons a page references. */
function referenced(html: string): string[] {
	return [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|png|svg|webmanifest))"/g)]
		.map((match) => match[1])
		.filter((path): path is string => !!path);
}

/** Drop scripts and styles of earlier builds, which the current page no longer uses. */
async function prune(cache: Cache, html: string): Promise<void> {
	const used = new Set(referenced(html));
	for (const request of await cache.keys()) {
		const path = new URL(request.url).pathname;
		if (HASHED.test(path) && !used.has(path)) await cache.delete(request);
	}
}

/** Cache the page plus the scripts, styles and icons it references. */
async function cacheShell(): Promise<void> {
	const cache = await caches.open(SHELL_CACHE);
	const page = await fetch(SHELL_PAGE, { cache: "no-store" });
	if (!page.ok) return;
	const html = await page.clone().text();
	await cache.put(SHELL_PAGE, page);
	await cache.addAll(referenced(html));
	await prune(cache, html);
}

self.addEventListener("install", (event) => {
	event.waitUntil(cacheShell().catch(() => {}));
	void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method !== "GET" || url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

	if (request.mode === "navigate") {
		// Fresh page when the server answers; the kept copy when it doesn't (offline, 502).
		event.respondWith(
			fetch(request)
				.then(async (response) => {
					if (response.ok) {
						const cache = await caches.open(SHELL_CACHE);
						await cache.put(SHELL_PAGE, response.clone());
						event.waitUntil(
							response
								.clone()
								.text()
								.then((html) => prune(cache, html))
								.catch(() => {}),
						);
						return response;
					}
					return (await caches.match(SHELL_PAGE)) ?? response;
				})
				.catch(async () => (await caches.match(SHELL_PAGE)) ?? Response.error()),
		);
		return;
	}

	const keep = async (response: Response) => {
		if (response.ok) await (await caches.open(SHELL_CACHE)).put(request, response.clone());
		return response;
	};
	// Scripts and styles named after their content never change: the kept copy wins.
	if (HASHED.test(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then(keep)));
		return;
	}
	// Icons and the manifest keep their names when they change: fresh when the server answers.
	event.respondWith(
		fetch(request)
			.then(keep)
			.catch(async () => (await caches.match(request)) ?? Response.error()),
	);
});

/** Take back the notification of a session that no longer needs you. */
async function clearNotice(tag: string): Promise<void> {
	for (const notification of await self.registration.getNotifications({ tag })) {
		notification.close();
	}
}

async function showNotice(notice: Notice): Promise<void> {
	const [windows, subscription] = await Promise.all([
		self.clients.matchAll({ type: "window", includeUncontrolled: true }),
		self.registration.pushManager.getSubscription(),
	]);
	// You're looking at the dashboard, which already shows this; like a chat app, stay quiet.
	if (dashboardShowsIt(windows, subscription?.endpoint)) return;
	// Chrome reads `renotify`, which TypeScript's DOM types don't list yet.
	const options: NotificationOptions & { renotify: boolean } = {
		body: notice.body,
		tag: notice.tag,
		// A new need replaces the old notification for that session; still alert for it.
		renotify: true,
		icon: "/icon-192.png",
		// Android draws the badge from its transparency alone, so it needs a white silhouette.
		badge: "/badge-96.png",
	};
	await self.registration.showNotification(notice.title, options);
}

self.addEventListener("push", (event) => {
	event.waitUntil(
		readNotice(event.data).then((notice) => {
			if (!notice) return;
			return notice.kind === "clear" ? clearNotice(notice.tag) : showNotice(notice);
		}),
	);
});

// Browsers replace subscriptions now and then; register the new one so notifications keep coming.
self.addEventListener("pushsubscriptionchange", (event) => {
	(event as ExtendableEvent).waitUntil(
		Promise.all([getItem<string>("viewSecret"), optedOut()]).then(([secret, off]) =>
			secret && !off ? syncSubscription(self.registration, secret).catch(() => {}) : undefined,
		),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
			return open ? open.focus() : self.clients.openWindow("/");
		}),
	);
});
