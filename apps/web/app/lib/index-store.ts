import { createSessionWorkGuard } from '@web/lib/session-work';

/**
 * The status of a store whose whole content is one server-owned index.
 *
 * `offline` is its own value rather than a flavour of `failed`: a pull that
 * never left the device says nothing about the server, and a background one is
 * not worth reporting at all — the app shell starts without a network on
 * purpose. A screen that shows a persistent panel treats both the same; code
 * that decides whether to speak reports only `failed`.
 */
export type IndexStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'failed';

/**
 * What one `load` call actually did.
 *
 * Returned rather than read back from `status` afterwards: `status` is shared
 * state, so with two calls interleaved — a refresh and a search, say — reading
 * it after an await reports somebody else's result. That is how the shell's
 * refresh coordinator came to credit a failed pull as fresh, and to back off a
 * system whose pull had succeeded.
 */
export type IndexLoadOutcome =
	| 'loaded'
	| 'unchanged'
	| 'skipped'
	| 'offline'
	| 'failed';

/** Whether a pull brought this store up to date with the server. */
export const indexLoadSucceeded = (outcome: IndexLoadOutcome) =>
	outcome === 'loaded' || outcome === 'unchanged';

/**
 * Whether the last read left the store unable to answer.
 *
 * A screen showing a persistent panel treats both failures the same — the
 * reader wants to know why the list is empty and how to retry, not whose fault
 * it was — and asking here keeps a screen from checking `=== 'failed'` alone and
 * silently rendering an offline store as if it were still loading.
 */
export const indexUnavailable = (status: IndexStatus) =>
	status === 'failed' || status === 'offline';

/**
 * Why a write did not land, for the subject that failed: "This rename", "Your
 * payments". Only for the case where the two branches really are the same
 * sentence with a different subject — a system whose failure deserves its own
 * wording writes its own, because reporting distinct causes under one generic
 * message is what this repo does not do.
 */
export const offlineMessage = (subject: string) =>
	navigator.onLine
		? `${subject} could not reach the server. Try again in a moment.`
		: `No connection. ${subject} needs to reach the server.`;

/** One page-less index read: `'unchanged'` when the held tag still matches. */
export type IndexRead<Item> = (
	knownTag: string | undefined,
) => Promise<{ items: Item[]; tag?: string } | 'unchanged'>;

/** The fields every index store carries, whatever it calls its collection. */
export type IndexCore = {
	status: IndexStatus;
	error?: string;
	/** What the server called the copy held here, so a refresh can ask for less. */
	tag?: string;
};

/**
 * A request slot that at most one caller occupies.
 *
 * Concurrent callers share one request rather than racing to overwrite each
 * other, and the slot is released only by the request that still owns it: one
 * that was superseded and settles late would otherwise free a newer request's
 * slot, letting a third caller start work that discards an answer already in
 * hand.
 */
export function createCoalescedRequest<T>() {
	let inFlight: Promise<T> | undefined;
	return {
		get pending() {
			return inFlight;
		},
		run(body: () => Promise<T>) {
			if (inFlight) return inFlight;
			const request = body();
			inFlight = request;
			void request.finally(() => {
				if (inFlight === request) inFlight = undefined;
			});
			return request;
		},
		clear() {
			inFlight = undefined;
		},
	};
}

type IndexCoreConfig<State extends IndexCore, Item extends { id: string }> = {
	get: () => State;
	/**
	 * Applies one change: `items` replaces the collection, the rest is core
	 * state. An adapter written by each store rather than a generic `set`,
	 * because Zustand's setter cannot take a literal for an unresolved `State`
	 * — the alternative was a cast in the one place that must not lie — and it
	 * lets every store keep calling its collection what its consumers do.
	 */
	patch: (next: Partial<IndexCore> & { items?: Item[] }) => void;
	read: IndexRead<Item>;
	/** Where this store keeps the collection. */
	select: (state: State) => Item[];
	/** Both halves spelled out, because the subject's verb differs per system. */
	failure: { unreachable: string; offline: string };
};

/**
 * The behaviour shared by every store whose content is one server-owned index:
 * coalescing, the session guard, the status/error transitions and the mutators
 * that invalidate the entity tag.
 *
 * It exists because four stores had grown a copy of this choreography and they
 * had already drifted — one released its request slot unconditionally, another
 * dropped the session guard entirely, which let a pull repopulate state after
 * sign-out. Every cross-cutting rule added here now lands in all of them.
 */
export function createIndexCore<
	State extends IndexCore,
	Item extends { id: string },
>(config: IndexCoreConfig<State, Item>) {
	const { get, patch, read, select, failure } = config;
	const request = createCoalescedRequest<IndexLoadOutcome>();

	return {
		status: 'idle' as IndexStatus,

		async load(
			force = false,
			isCurrent = createSessionWorkGuard(),
		): Promise<IndexLoadOutcome> {
			if (request.pending) return request.pending;
			if (!force && get().status === 'ready') return 'skipped';
			// `undefined` means sign-out already invalidated this generation.
			if (!isCurrent?.()) return 'skipped';

			// Kept for the whole trip, so a screen with content can tell a
			// background refresh from a first load and refuse to blank itself.
			patch({ status: 'loading' });
			return request.run(async () => {
				try {
					const answer = await read(get().tag);
					if (!isCurrent()) return 'skipped';
					if (answer === 'unchanged') {
						patch({ status: 'ready', error: undefined });
						return 'unchanged';
					}
					patch({
						items: answer.items,
						tag: answer.tag,
						status: 'ready',
						error: undefined,
					});
					return 'loaded';
				} catch {
					if (!isCurrent()) return 'skipped';
					const online = navigator.onLine;
					patch({
						status: online ? 'failed' : 'offline',
						error: online ? failure.unreachable : failure.offline,
					});
					return online ? 'failed' : 'offline';
				}
			});
		},

		reset() {
			request.clear();
			patch({ items: [], status: 'idle', error: undefined, tag: undefined });
		},

		upsert(updated: Item[]) {
			const byId = new Map(updated.map((entry) => [entry.id, entry]));
			const held = select(get());
			const known = new Set(held.map((entry) => entry.id));
			patch({
				// The tag described what the server sent, and this is no longer that.
				tag: undefined,
				items: [
					...held.map((entry) => byId.get(entry.id) ?? entry),
					...updated.filter((entry) => !known.has(entry.id)),
				],
			});
		},

		remove(ids: string[]) {
			const dropped = new Set(ids);
			patch({
				tag: undefined,
				items: select(get()).filter((entry) => !dropped.has(entry.id)),
			});
		},
	};
}
