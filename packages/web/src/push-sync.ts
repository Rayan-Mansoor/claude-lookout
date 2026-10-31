import {
	API,
	deriveSpace,
	fromBase64Url,
	penalisesSilentPush,
	toBase64Url,
} from "@claude-lookout/protocol";
import { getItem, removeItem, setItem } from "./storage.ts";

/**
 * Keeps this device's push subscription registered with the hub. Shared by the page and the
 * service worker, so a subscription the browser replaces in the background is re-registered
 * without the page being open.
 */

const SUBSCRIPTION_ID = "pushSubscriptionId";
const OPTED_OUT = "pushOptedOut";

async function subscriptionId(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(viewSecret: string) {
	const { spaceId, viewToken } = await deriveSpace(viewSecret);
	return { base: API.space(spaceId), headers: { authorization: `Bearer ${viewToken}` } };
}

function keyOf(subscription: PushSubscription): string | undefined {
	const key = subscription.options.applicationServerKey;
	return key ? toBase64Url(new Uint8Array(key)) : undefined;
}

/**
 * Whether a notification can stay hidden because the dashboard is on screen and in front, where
 * it already shows what the notification would say. Never on a subscription that is cancelled
 * for pushes that show nothing (Safari's), where it always shows.
 */
export function dashboardShowsIt(
	windows: readonly { visibilityState: DocumentVisibilityState; focused: boolean }[],
	endpoint: string | undefined,
): boolean {
	if (!endpoint || penalisesSilentPush(endpoint)) return false;
	return windows.some((w) => w.visibilityState === "visible" && w.focused);
}

/** True when the person turned notifications off on this device. */
export async function optedOut(): Promise<boolean> {
	return (await getItem<boolean>(OPTED_OUT)) === true;
}

export async function setOptedOut(value: boolean): Promise<void> {
	await setItem(OPTED_OUT, value);
}

/**
 * Make sure this device has a subscription for the space's current key and that the hub knows
 * it, replacing whatever this device registered before. Needs notification permission.
 */
/** How long a call to the hub may take before it counts as failed. */
const HUB_TIMEOUT_MS = 10_000;

export async function syncSubscription(
	registration: ServiceWorkerRegistration,
	viewSecret: string,
): Promise<void> {
	const { base, headers } = await authorized(viewSecret);
	const keyRes = await fetch(`${base}/push/key`, {
		headers,
		signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
	});
	if (!keyRes.ok) throw new Error(`HTTP ${keyRes.status}`);
	const { publicKey } = (await keyRes.json()) as { publicKey: string };

	let subscription = await registration.pushManager.getSubscription();
	if (subscription && keyOf(subscription) !== publicKey) {
		// Made for another space (the view link changed): start over with this space's key.
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: fromBase64Url(publicKey),
	});

	const id = await subscriptionId(subscription.endpoint);
	const res = await fetch(`${base}/push/subscriptions/${id}`, {
		method: "PUT",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(subscription.toJSON()),
		signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const previous = await getItem<string>(SUBSCRIPTION_ID);
	if (previous && previous !== id) {
		await fetch(`${base}/push/subscriptions/${previous}`, {
			method: "DELETE",
			headers,
			signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
		}).catch(() => {});
	}
	await setItem(SUBSCRIPTION_ID, id);
}

/**
 * Unsubscribe this device and tell the hub to forget it. The device stops receiving at once; the
 * hub is told afterwards, as far as it can be reached.
 */
export async function dropSubscription(
	registration: ServiceWorkerRegistration,
	viewSecret: string,
): Promise<void> {
	const subscription = await registration.pushManager.getSubscription();
	const id =
		(await getItem<string>(SUBSCRIPTION_ID)) ??
		(subscription ? await subscriptionId(subscription.endpoint) : undefined);
	await subscription?.unsubscribe().catch(() => false);
	await removeItem(SUBSCRIPTION_ID);
	if (id) {
		const { base, headers } = await authorized(viewSecret);
		await fetch(`${base}/push/subscriptions/${id}`, {
			method: "DELETE",
			headers,
			signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
		}).catch(() => {});
	}
}
