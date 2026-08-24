import { activeSystem, appSystems } from '@web/lib/app-systems';
import {
	listenForReturnSignals,
	type ReturnSignalReason,
} from '@web/lib/return-signals';
import {
	createSessionWorkGuard,
	type SessionWorkGuard,
} from '@web/lib/session-work';
import { useEffect, useRef } from 'react';

/**
 * How old the data on screen may be before the next sign of life is worth a
 * round trip.
 *
 * This is not a poll interval — nothing here runs on a timer, and an app nobody
 * is touching makes no requests at all, which keeps the serverless container
 * asleep. It is the age at which someone coming back to the machine deserves a
 * fresher answer. Every system sends `If-None-Match`, so a system that did not
 * change costs one 304 and no payload.
 */
export const SYSTEM_REFRESH_STALE_MS = 180_000;
export const SYSTEM_REFRESH_RETRY_BASE_MS = 5_000;
export const SYSTEM_REFRESH_RETRY_MAX_MS = 60_000;

/** The active system, reduced to what refreshing it needs. */
export type RefreshTarget = {
	key: string;
	/** Resolves `false` when the pull failed, so the age is not credited. */
	refresh: (isCurrent: SessionWorkGuard) => Promise<boolean>;
};

type CoordinatorOptions = {
	/**
	 * Everything worth refreshing right now: the system on screen, plus the ones
	 * whose data is read from anywhere. Deduped by key upstream, so each key
	 * ages on one clock no matter how many reasons put it in the list.
	 */
	getTargets: () => RefreshTarget[];
	now?: () => number;
	isOnline?: () => boolean;
	staleMs?: number;
	retryBaseMs?: number;
	retryMaxMs?: number;
};

/**
 * Refreshes the system on screen when someone returns to a stale one.
 *
 * Knows nothing about which systems exist: the shell hands it whatever the
 * current route resolves to. Ages every system on its own clock, because
 * arriving at a screen is the only moment its staleness can be judged — the
 * stores that skip a reload when they are already `ready` would otherwise show
 * an hour-old index with no request in sight.
 */
export function createRefreshCoordinator({
	getTargets,
	now = () => Date.now(),
	isOnline = () => navigator.onLine,
	staleMs = SYSTEM_REFRESH_STALE_MS,
	retryBaseMs = SYSTEM_REFRESH_RETRY_BASE_MS,
	retryMaxMs = SYSTEM_REFRESH_RETRY_MAX_MS,
}: CoordinatorOptions) {
	const states = new Map<
		string,
		{ refreshedAt: number; failures: number; retryAt?: number }
	>();

	const pull = (target: RefreshTarget) => {
		const isCurrent = createSessionWorkGuard();
		if (!isCurrent) return;
		const state = states.get(target.key) ?? {
			refreshedAt: 0,
			failures: 0,
		};
		state.refreshedAt = now();
		state.retryAt = undefined;
		states.set(target.key, state);
		const failed = () => {
			state.failures += 1;
			state.retryAt =
				now() + Math.min(retryBaseMs * 2 ** (state.failures - 1), retryMaxMs);
		};
		void target.refresh(isCurrent).then((fresh) => {
			if (!fresh) {
				failed();
				return;
			}
			state.failures = 0;
		}, failed);
	};

	/**
	 * A signal arrived with no connection to serve it.
	 *
	 * This is what makes the next reconnect meaningful, and why it is not a plain
	 * "always pull when `online` fires": armed only by somebody actually being
	 * here while the connection was down, so an app nobody is touching still
	 * makes no request no matter how much the Wi-Fi flaps. It is spent on the
	 * reconnect it unblocks — one extra pull per outage, not per transition.
	 */
	let blockedWhileOffline = false;

	const signal = (reason: ReturnSignalReason = 'activity') => {
		if (!isOnline()) {
			blockedWhileOffline = true;
			return;
		}
		const targets = getTargets();
		if (targets.length === 0) return;
		// A connection coming back is evidence of queued work that can finally
		// ship — `refresh` drains the system's outbox before it pulls — which is a
		// different claim from "this data may be old", so age does not gate it.
		// Spent once for the whole pass, not once per target: an outage unblocks
		// every system at the same time.
		const unblocks = reason === 'reconnect' && blockedWhileOffline;
		if (unblocks) blockedWhileOffline = false;
		const time = now();

		for (const target of targets) {
			const state = states.get(target.key);
			// A failed pull keeps its backoff even on reconnect: retrying faster than
			// 5s because the connection blinked is the storm this bound exists for.
			if (state?.retryAt !== undefined && time < state.retryAt) continue;
			if (
				!unblocks &&
				state &&
				state.retryAt === undefined &&
				time - state.refreshedAt < staleMs
			)
				continue;
			pull(target);
		}
	};

	return {
		/**
		 * A sign of life, or an arrival at a screen. Pulls only if what it would
		 * refresh has aged out; a system never seen before always has.
		 *
		 * Arriving somewhere signals too, and does not try to guess whether the
		 * route is loading itself: every system coalesces concurrent pulls, so the
		 * request this starts on mount is the same one the screen already wanted.
		 *
		 * `reconnect` skips the age check, because a connection that came back
		 * changes what is *possible*, not just what is likely.
		 */
		signal,

		/** Attaches every signal to the document; returns the detach. */
		listen() {
			return listenForReturnSignals(signal);
		},
	};
}

export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>;

/**
 * Wires the coordinator to the route, once, for the whole shell.
 *
 * The listeners are attached a single time and read the current route through a
 * ref: re-registering five document listeners on every keystroke that changes
 * the search string would be the expensive part of an otherwise free feature.
 */
export function useSystemRefresh(
	pathname: string,
	search: string,
	/** Off until the session is restored: an unauthenticated pull only 401s. */
	enabled: boolean,
) {
	const route = useRef({ pathname, search });
	useEffect(() => {
		route.current = { pathname, search };
	});

	const held = useRef<RefreshCoordinator>(null);
	held.current ??= createRefreshCoordinator({
		getTargets: () => {
			const active = activeSystem(route.current.pathname);
			const targets: RefreshTarget[] = [];
			// The system on screen first, and with the search string: what is open
			// can be part of what needs refreshing, as the note Notes has selected
			// is. Being first is what makes it win the dedupe below.
			if (active?.refresh) {
				const { refresh } = active;
				targets.push({
					key: active.key,
					refresh: (isCurrent) => refresh(route.current.search, isCurrent),
				});
			}
			for (const system of appSystems) {
				if (!system.refreshEverywhere || !system.refresh) continue;
				if (targets.some((target) => target.key === system.key)) continue;
				const { refresh } = system;
				// No search off-route: there is no selection on a screen that is not
				// this system's, so this asks for the index and nothing else.
				targets.push({
					key: system.key,
					refresh: (isCurrent) => refresh('', isCurrent),
				});
			}
			return targets;
		},
	});
	const coordinator = held.current;

	useEffect(() => {
		if (!enabled) return;
		return coordinator.listen();
	}, [coordinator, enabled]);

	// Arriving at a screen is the only moment its own staleness can be judged:
	// Finance, Storage and Credentials all skip their load when the store is
	// already `ready`, so without this they would show an hour-old index. The
	// first run is also what pulls the app-wide indexes at startup, which is why
	// it does not wait for the route to resolve to a system.
	const activeKey = activeSystem(pathname)?.key;
	// biome-ignore lint/correctness/useExhaustiveDependencies(activeKey): arriving at a system is the trigger, not an input — the coordinator reads the route through the ref.
	useEffect(() => {
		if (enabled) coordinator.signal();
	}, [activeKey, coordinator, enabled]);
}
