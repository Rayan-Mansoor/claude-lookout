import { BLOCKED_STATES, formatDuration, type SessionView } from "@claude-lookout/protocol";
import { useEffect, useState } from "preact/hooks";
import { forgetPush, type PushState, usePush } from "./notifications.ts";
import { useRoute } from "./router.ts";
import { SessionCard } from "./session-card.tsx";
import { urgency } from "./session-format.ts";
import { SessionScreen } from "./session-screen.tsx";
import {
	type Connection,
	LAST_UPDATES_KEY,
	type MachineState,
	OFFLINE_AFTER_MS,
	parseViewSecret,
	useNow,
	useSpace,
} from "./space.ts";
import { getItem, removeItem, setItem } from "./storage.ts";

const SECRET_KEY = "viewSecret";

const CONNECTION_LABELS: Record<Connection, string> = {
	connecting: "Connecting…",
	live: "Live",
	retrying: "Can't connect",
	denied: "This link no longer works",
};

function byUrgency(a: SessionView, b: SessionView): number {
	return urgency(a) - urgency(b) || b.since - a.since;
}

function Pairing({ onPaired }: { onPaired: (secret: string) => void }) {
	const [value, setValue] = useState("");
	const [invalid, setInvalid] = useState(false);

	const submit = (event: Event) => {
		event.preventDefault();
		const secret = parseViewSecret(value);
		if (secret) onPaired(secret);
		else setInvalid(true);
	};

	return (
		<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
			<Logo />
			<h1 class="mt-6 text-2xl font-semibold tracking-tight">Look in on Claude Code</h1>
			<p class="mt-2 text-muted">
				Open the view link that <code class="font-mono text-sm">claude-lookout setup</code> printed
				on your computer, or scan its QR code. This device remembers it after that.
			</p>
			<form class="mt-8 space-y-3" onSubmit={submit}>
				<label class="block text-sm font-medium" for="link">
					Or paste the view link
				</label>
				<input
					id="link"
					class="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-sm outline-none transition-colors focus:border-lamp"
					value={value}
					autocomplete="off"
					spellcheck={false}
					placeholder="https://…/#k=…"
					onInput={(e) => {
						setValue((e.target as HTMLInputElement).value);
						setInvalid(false);
					}}
				/>
				{invalid && <p class="text-sm text-halt">That doesn't look like a view link.</p>}
				<button
					type="submit"
					class="w-full rounded-xl bg-ink px-4 py-2.5 font-medium text-bg transition-opacity hover:opacity-90"
				>
					Open dashboard
				</button>
			</form>
		</main>
	);
}

function Logo() {
	return (
		<div class="flex items-center gap-2.5">
			<svg viewBox="0 0 64 64" class="size-7" aria-hidden="true">
				<rect width="64" height="64" rx="14" class="fill-ink" />
				<path
					d="M22 54V24a6 6 0 0 1 6-6h12"
					fill="none"
					stroke-width="8"
					stroke-linecap="round"
					class="stroke-bg"
				/>
				<circle cx="44" cy="18" r="6.5" class="fill-lamp" />
				<path
					d="M51 9.5a12 12 0 0 1 0 17"
					fill="none"
					stroke-width="3"
					stroke-linecap="round"
					class="stroke-lamp"
					opacity=".8"
				/>
			</svg>
			<span class="font-semibold tracking-tight">Lookout</span>
		</div>
	);
}

function MachineGroup({
	machine,
	shownAbove,
	now,
	serverNow,
}: {
	machine: MachineState;
	/** Sessions already listed under "Needs you". */
	shownAbove: Set<string>;
	now: number;
	serverNow: number;
}) {
	const all = machine.snapshot.sessions;
	const sessions = all.filter((s) => !shownAbove.has(s.id)).sort(byUrgency);
	const silentFor = serverNow - machine.receivedAt;
	const offline = silentFor > OFFLINE_AFTER_MS;
	if (all.length > 0 && sessions.length === 0) return null;
	return (
		<section class={`space-y-2.5 transition-opacity ${offline ? "opacity-55" : ""}`}>
			<h2 class="flex items-baseline justify-between gap-3 px-1 text-sm">
				<span class="truncate font-medium text-muted">{machine.snapshot.machine.name}</span>
				{offline && (
					<span class="shrink-0 text-muted">
						Offline · last seen {formatDuration(silentFor)} ago
					</span>
				)}
			</h2>
			{sessions.length === 0 ? (
				<p class="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
					No Claude Code sessions are open.
				</p>
			) : (
				sessions.map((s) => (
					<SessionCard
						key={s.id}
						machine={machine.id}
						session={s}
						now={now + machine.clockOffset}
					/>
				))
			)}
		</section>
	);
}

function NotifyPrompt({ state, enable }: { state: PushState; enable: () => void }) {
	const message: Partial<Record<PushState, string>> = {
		off: "Get a notification when a session needs you or finishes.",
		"install-first":
			"To get notifications on iPhone or iPad, add Lookout to your Home Screen first: Share, then Add to Home Screen.",
		blocked: "Notifications are blocked for this site in your browser settings.",
	};
	const text = message[state];
	if (!text) return null;
	return (
		<div class="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5">
			<p class="min-w-0 flex-1 text-sm text-muted">{text}</p>
			{state === "off" && (
				<button
					type="button"
					class="shrink-0 rounded-xl bg-ink px-3.5 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90"
					onClick={enable}
				>
					Turn on
				</button>
			)}
		</div>
	);
}

function NotifyFooter({ state, disable }: { state: PushState; disable: () => void }) {
	if (state !== "on") return null;
	return (
		<button
			type="button"
			class="text-sm text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
			onClick={disable}
		>
			Turn off notifications
		</button>
	);
}

function Dashboard({ secret, onForget }: { secret: string; onForget: () => void }) {
	const { machines, connection, clockOffset } = useSpace(secret);
	const push = usePush(secret);
	const now = useNow();
	const serverNow = now + clockOffset;
	const route = useRoute();
	const list = [...machines.values()].sort((a, b) =>
		a.snapshot.machine.name.localeCompare(b.snapshot.machine.name),
	);
	// What waits on you comes first, from every computer still online; an offline one can't be answered.
	const needsYou = list
		.filter((m) => serverNow - m.receivedAt <= OFFLINE_AFTER_MS)
		.flatMap((m) =>
			m.snapshot.sessions
				.filter((s) => BLOCKED_STATES.includes(s.state))
				.map((session) => ({ machine: m, session })),
		)
		.sort((a, b) => byUrgency(a.session, b.session));
	const waiting = needsYou.length;
	const shownAbove = new Set(needsYou.map((n) => n.session.id));

	useEffect(() => {
		document.title = waiting > 0 ? `(${waiting}) Lookout` : "Lookout";
	}, [waiting]);

	if (route.name === "session") {
		const machine = machines.get(route.machine);
		const silentFor = machine ? serverNow - machine.receivedAt : 0;
		return (
			<SessionScreen
				machine={machine}
				sessionId={route.session}
				section={route.section}
				// Times come from that machine's clock, so read them against it.
				now={now + (machine?.clockOffset ?? 0)}
				loading={connection !== "live"}
				offlineFor={silentFor > OFFLINE_AFTER_MS ? silentFor : undefined}
			/>
		);
	}

	return (
		<main class="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-10">
			<header class="flex items-center justify-between gap-3">
				<Logo />
				<span class="flex items-center gap-2 text-sm text-muted" role="status">
					<span
						class={`size-2 rounded-full ${connection === "live" ? "bg-done" : connection === "denied" ? "bg-halt" : "bg-idle pulse"}`}
						aria-hidden="true"
					/>
					{CONNECTION_LABELS[connection]}
				</span>
			</header>

			{connection === "retrying" && list.length > 0 && (
				<p class="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
					Can't reach your computer right now. Showing what it last reported; this updates by itself
					once it's back.
				</p>
			)}

			<div class="mt-6 space-y-8">
				{connection !== "denied" && waiting > 0 && (
					<section class="space-y-2.5">
						<h2 class="px-1 text-sm font-medium text-lamp">Needs you · {waiting}</h2>
						{needsYou.map(({ machine, session }) => (
							<SessionCard
								key={session.id}
								machine={machine.id}
								machineName={list.length > 1 ? machine.snapshot.machine.name : undefined}
								session={session}
								now={now + machine.clockOffset}
							/>
						))}
					</section>
				)}
				{connection === "denied" ? (
					<p class="text-muted">
						The view link was changed on your computer. Open the new one to keep watching.
					</p>
				) : list.length === 0 ? (
					<p class="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-muted">
						{connection === "live"
							? "Nothing to show yet. Sessions appear here as soon as Claude Code runs."
							: "Waiting for your computer…"}
					</p>
				) : (
					list.map((m) => (
						<MachineGroup
							key={m.id}
							machine={m}
							shownAbove={shownAbove}
							now={now}
							serverNow={serverNow}
						/>
					))
				)}
			</div>

			<NotifyPrompt state={push.state} enable={() => void push.enable()} />

			<footer class="mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2">
				<NotifyFooter state={push.state} disable={() => void push.disable()} />
				<button
					type="button"
					class="text-sm text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
					onClick={onForget}
				>
					Forget this device
				</button>
			</footer>
		</main>
	);
}

export function App() {
	const [secret, setSecret] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		// A view link carries the secret in the #fragment, which browsers never send to a server.
		const fromLink = parseViewSecret(location.hash);
		if (fromLink) {
			history.replaceState(null, "", location.pathname);
			void setItem(SECRET_KEY, fromLink);
			setSecret(fromLink);
			return;
		}
		void getItem<string>(SECRET_KEY).then((saved) => setSecret(saved ?? null));
	}, []);

	if (secret === undefined) return null;
	if (secret === null) {
		return (
			<Pairing
				onPaired={(s) => {
					void setItem(SECRET_KEY, s);
					setSecret(s);
				}}
			/>
		);
	}
	return (
		<Dashboard
			secret={secret}
			onForget={() => {
				// Forget the link first, so nothing that follows can leave this device paired.
				void removeItem(SECRET_KEY);
				void removeItem(LAST_UPDATES_KEY);
				void forgetPush(secret);
				setSecret(null);
			}}
		/>
	);
}
