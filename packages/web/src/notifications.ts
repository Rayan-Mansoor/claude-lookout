import { useEffect, useState } from "preact/hooks";
import { dropSubscription, optedOut, setOptedOut, syncSubscription } from "./push-sync.ts";

export type PushState = "unsupported" | "install-first" | "off" | "on" | "blocked" | "busy";

const supported = () =>
	"serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** iPhones and iPads only allow web push from a page added to the Home Screen. */
const needsInstall = () =>
	/iPhone|iPad|iPod/.test(navigator.userAgent) &&
	!window.matchMedia("(display-mode: standalone)").matches;

export function registerServiceWorker(): void {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.register("/sw.js").catch(() => {});
	}
}

/** The service worker once it is active, or a failure after a while: it may never become one. */
function workerReady(): Promise<ServiceWorkerRegistration> {
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("no service worker")), 10_000),
		),
	]);
}

/** Stop notifications for this device, e.g. when it forgets the view link. */
export async function forgetPush(viewSecret: string): Promise<void> {
	if (!supported()) return;
	const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
	if (registration) await dropSubscription(registration, viewSecret).catch(() => {});
}

/** Whether this device is subscribed, as far as it can tell without the hub. */
async function subscribedHere(): Promise<boolean> {
	const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
	return !!(await registration?.pushManager.getSubscription().catch(() => null));
}

/**
 * Whether this device gets notified, and the switch to change it. Once permission is granted,
 * the subscription is checked and renewed on every visit, so notifications stay on until the
 * person turns them off.
 */
export function usePush(viewSecret: string) {
	const [state, setState] = useState<PushState>("busy");

	useEffect(() => {
		if (!supported()) return setState(needsInstall() ? "install-first" : "unsupported");
		if (Notification.permission === "denied") return setState("blocked");
		if (Notification.permission !== "granted") return setState("off");
		let cancelled = false;
		optedOut()
			.then(async (off) => {
				if (off) return "off" as const;
				await syncSubscription(await workerReady(), viewSecret);
				return "on" as const;
			})
			// The hub may just be out of reach: a device still subscribed stays on, and is
			// registered again on the next visit.
			.catch(async () => ((await subscribedHere()) ? ("on" as const) : ("off" as const)))
			.then((next) => !cancelled && setState(next));
		return () => {
			cancelled = true;
		};
	}, [viewSecret]);

	const enable = async () => {
		setState("busy");
		try {
			if ((await Notification.requestPermission()) !== "granted") {
				setState(Notification.permission === "denied" ? "blocked" : "off");
				return;
			}
			await setOptedOut(false);
			await syncSubscription(await workerReady(), viewSecret);
			setState("on");
		} catch {
			setState("off");
		}
	};

	const disable = async () => {
		setState("busy");
		try {
			await setOptedOut(true);
			const registration = await navigator.serviceWorker.getRegistration();
			if (registration) await dropSubscription(registration, viewSecret);
		} catch {
			// Opted out all the same: nothing is shown on this device any more.
		} finally {
			setState("off");
		}
	};

	return { state, enable, disable };
}
