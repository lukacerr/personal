import { readAgentLocal, threadBusyFailure } from '@web/lib/agent';
import {
	AgentApiError,
	type AgentCatalog,
	type AgentSettings,
	type AgentThread,
	type AgentThreadCursor,
	bulkDeleteThreads,
	deleteThread,
	generateThreadTitle,
	listThreads,
	readAgentSettings,
	readCatalog,
	renameThread,
	writeAgentSettings,
} from '@web/lib/agent-api';
import {
	loadAgentSettings,
	reconcileAgentSettings,
	saveAgentSettings,
} from '@web/lib/agent-settings';
import {
	createCoalescedRequest,
	type IndexLoadOutcome,
	type IndexStatus,
	offlineMessage,
} from '@web/lib/index-store';
import {
	createSessionWorkGuard,
	type SessionWorkGuard,
} from '@web/lib/session-work';
import { create } from 'zustand';

type AgentState = {
	threads: AgentThread[];
	/** Static per session: the registries only change with a deploy. */
	catalog?: AgentCatalog;
	/**
	 * The same statuses the other index stores use, including `offline` as its
	 * own value. This store keeps its own `load` — pages, a query and a
	 * generation clock do not fit the shared core — but not its own vocabulary.
	 */
	status: IndexStatus;
	error?: string;
	/** What the server called the copy held here, so a refresh can ask for less. */
	tag?: string;
	/** The cursor of the last row held, or `null` when the list is complete. */
	nextCursor: AgentThreadCursor | null;
	loadingMore: boolean;
	loadMoreError?: string;
	/** Number of index pages retained, including a final page with no cursor. */
	loadedPages: number;
	/** The active title filter. Empty means the plain index. */
	query: string;
	/**
	 * Every shared Agent choice. `undefined` means reconciliation has not
	 * completed; afterward this is always a concrete object, including `{}`.
	 */
	settings?: AgentSettings;
	load: (
		force?: boolean,
		isCurrent?: SessionWorkGuard,
	) => Promise<IndexLoadOutcome>;
	loadMore: () => Promise<void>;
	search: (query: string) => Promise<void>;
	loadSettings: () => Promise<void>;
	saveSettings: (patch: Partial<AgentSettings>) => Promise<string | undefined>;
	rename: (id: string, title: string) => Promise<string | undefined>;
	remove: (id: string) => Promise<string | undefined>;
	removeMany: (ids: string[]) => Promise<{ deleted: string[]; error?: string }>;
	generateTitle: (id: string, model: string) => Promise<string | undefined>;
	upsertLocal: (thread: AgentThread) => void;
	/** Clears session-scoped server data on sign-out. */
	reset: () => void;
};

/** A read that failed, split so a pull that never left the device stays quiet. */
const readFailure = (subject: string) =>
	navigator.onLine
		? { status: 'failed' as const, error: offlineMessage(subject) }
		: { status: 'offline' as const, error: offlineMessage(subject) };

/**
 * A write that failed. `409` is not a connectivity problem: it is the server
 * saying a turn currently holds this thread's mutation lease, which is a
 * condition the reader can act on by waiting. The transcript says the same
 * thing about a turn the lease refused, so the sentence itself lives in
 * `lib/agent` and neither side owns a second copy of it.
 */
function writeFailure(error: unknown, subject: string) {
	if (error instanceof AgentApiError && error.status === 409)
		return threadBusyFailure(subject);
	return offlineMessage(subject);
}

/** Newest first, with the id as the tiebreaker the server orders by too. */
function byRecency(a: AgentThread, b: AgentThread) {
	return b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1);
}

/**
 * The one copy of the thread index the app keeps.
 *
 * Agent is not local-first: the API is the source, messages live with each
 * open conversation — never here — and the index arrives one page at a time,
 * newest first, because a year of conversations is not a payload.
 */
export const useAgentStore = create<AgentState>()((set, get) => {
	const indexRequest = createCoalescedRequest<IndexLoadOutcome>();
	let moreInFlight: Promise<void> | undefined;
	let listGeneration = 0;
	let settingsRevision = 0;
	let settingsGeneration = 0;
	let settingsQueue: Promise<unknown> = Promise.resolve();
	let persistedSettings: AgentSettings | null | undefined;
	let retrySettingsRead = false;
	let settingsLoad:
		| Promise<ReturnType<typeof reconcileAgentSettings>>
		| undefined;

	function loadReconciledSettings(generation: number) {
		const local = loadAgentSettings(localStorage, readAgentLocal().selection);
		settingsLoad ??= readAgentSettings()
			.then((shared) => {
				if (generation !== settingsGeneration)
					throw new Error('Agent settings session changed');
				retrySettingsRead = false;
				return reconcileAgentSettings(shared, local);
			})
			.catch((error: unknown) => {
				if (generation === settingsGeneration) {
					retrySettingsRead = true;
					settingsLoad = undefined;
				}
				throw error;
			});
		return settingsLoad;
	}

	/** The first page of whatever the list currently shows. */
	async function loadFirstPage(
		generation: number,
		isCurrent: SessionWorkGuard,
	): Promise<IndexLoadOutcome> {
		const { catalog: known, query, tag } = get();
		const catalog = known ?? (await readCatalog());
		const answer = await listThreads({
			...(query ? { query } : {}),
			// A search has no entity tag to revalidate against. A forced read does:
			// `force` only means "do not trust the local `ready` short-circuit", and
			// every mutation already drops the tag, so revalidating stays correct
			// and an unchanged index costs a 304 instead of the whole page.
			...(!query && tag ? { knownTag: tag } : {}),
		});
		if (!isCurrent() || generation !== listGeneration || get().query !== query)
			return 'skipped';

		if (answer === 'unchanged') {
			set({ catalog, status: 'ready', error: undefined });
			return 'unchanged';
		}

		/**
		 * A background refresh must not throw away pages the reader already
		 * walked into. The fresh page wins for anything it contains — a thread
		 * whose title or recency changed moves with it — and everything below it
		 * is kept, deduped by id.
		 *
		 * The retained rows are read here, after the await, not from the snapshot
		 * taken before it: a row deleted while the request travelled is gone from
		 * the live list and absent from the fresh page, so merging the old array
		 * would put it back.
		 */
		const { loadedPages, nextCursor, threads } = get();
		const paginated = loadedPages > 1;
		const fresh = answer.threads;
		const freshIds = new Set(fresh.map((thread) => thread.id));
		const merged =
			paginated && !query
				? [...fresh, ...threads.filter((row) => !freshIds.has(row.id))].sort(
						byRecency,
					)
				: fresh;

		set({
			catalog,
			threads: merged,
			// Keeping older pages means the walk continues from where it was.
			nextCursor: paginated && !query ? nextCursor : answer.nextCursor,
			tag: query ? undefined : answer.tag,
			status: 'ready',
			error: undefined,
			loadedPages: paginated && !query ? loadedPages : 1,
		});
		return 'loaded';
	}

	return {
		threads: [],
		status: 'idle',
		nextCursor: null,
		loadingMore: false,
		loadedPages: 0,
		query: '',

		async load(
			force = false,
			isCurrent = createSessionWorkGuard(),
		): Promise<IndexLoadOutcome> {
			if (indexRequest.pending) return indexRequest.pending;
			if (!force && get().status === 'ready') return 'skipped';
			if (!isCurrent?.()) return 'skipped';

			const generation = ++listGeneration;
			set({ status: 'loading' });
			return indexRequest.run(async () => {
				try {
					return await loadFirstPage(generation, isCurrent);
				} catch {
					if (!isCurrent() || generation !== listGeneration) return 'skipped';
					const failure = readFailure('Your conversations');
					set(failure);
					return failure.status;
				}
			});
		},

		/** The next page down. Idempotent while one is already travelling. */
		async loadMore() {
			const { nextCursor: cursor, query } = get();
			if (indexRequest.pending || moreInFlight || !cursor) return moreInFlight;
			const generation = listGeneration;

			set({ loadingMore: true, loadMoreError: undefined });
			moreInFlight = (async () => {
				try {
					const answer = await listThreads({
						cursor,
						...(query ? { query } : {}),
					});
					if (answer === 'unchanged') return;
					if (generation !== listGeneration || get().query !== query) return;
					set(({ threads }) => {
						const known = new Set(threads.map((thread) => thread.id));
						return {
							threads: [
								...threads,
								...answer.threads.filter((row) => !known.has(row.id)),
							],
							nextCursor: answer.nextCursor,
							loadedPages: get().loadedPages + 1,
						};
					});
				} catch {
					if (generation === listGeneration && get().query === query)
						set({ loadMoreError: offlineMessage('More conversations') });
				} finally {
					if (generation === listGeneration) set({ loadingMore: false });
					moreInFlight = undefined;
				}
			})();
			return moreInFlight;
		},

		/** Reconciles shared, mirrored and legacy choices once per session. */
		async loadSettings() {
			if (get().settings !== undefined) return;
			const revision = settingsRevision;
			const generation = settingsGeneration;
			try {
				const reconciliation = await loadReconciledSettings(generation);
				if (generation !== settingsGeneration || revision !== settingsRevision)
					return;
				persistedSettings = reconciliation.settings;
				set({ settings: reconciliation.settings });
				saveAgentSettings(localStorage, reconciliation.settings);
				if (reconciliation.push) {
					const seed = settingsQueue.then(async () => {
						if (generation !== settingsGeneration) return;
						try {
							const saved = await writeAgentSettings(reconciliation.settings);
							if (generation === settingsGeneration) persistedSettings = saved;
						} catch {
							// The local mirror remains the valid offline copy.
						}
					});
					settingsQueue = seed;
					await seed;
				}
			} catch {
				if (
					generation === settingsGeneration &&
					revision === settingsRevision
				) {
					const local = loadAgentSettings(
						localStorage,
						readAgentLocal().selection,
					);
					set({ settings: local });
					saveAgentSettings(localStorage, local);
				}
				// A later save retries the read before replacing the shared object.
			}
		},

		/**
		 * Takes a patch, not the whole object, because the server's PUT replaces:
		 * merging here — over settings that were actually read — is what keeps
		 * one picker from silently wiping the other. If the first read failed,
		 * it is retried before writing rather than treated as "empty": writing
		 * over choices this device never saw would destroy them.
		 */
		async saveSettings(patch) {
			const generation = settingsGeneration;
			const previous = get().settings;
			const local =
				previous ?? loadAgentSettings(localStorage, readAgentLocal().selection);
			const optimistic = { ...local, ...patch };
			const revision = ++settingsRevision;
			set({ settings: optimistic });
			saveAgentSettings(localStorage, optimistic);

			const task = settingsQueue.then(async () => {
				if (generation !== settingsGeneration) return;
				if (persistedSettings === undefined) {
					if (previous !== undefined && !retrySettingsRead)
						persistedSettings = previous;
					else
						try {
							const reconciliation = await loadReconciledSettings(generation);
							if (generation !== settingsGeneration) return;
							persistedSettings = reconciliation.settings;
						} catch {
							if (generation !== settingsGeneration) return;
							return offlineMessage('Saving the agent settings');
						}
				}
				const settings = { ...persistedSettings, ...patch };
				// A failed share does not invalidate the local choice, and the next
				// queued patch must preserve it rather than rebuilding from Redis.
				persistedSettings = settings;
				try {
					const saved = await writeAgentSettings(settings);
					if (generation !== settingsGeneration) return;
					persistedSettings = { ...settings, ...saved };
					if (revision === settingsRevision) {
						set({ settings: persistedSettings });
						saveAgentSettings(localStorage, persistedSettings);
					}
				} catch {
					if (generation !== settingsGeneration) return;
					return offlineMessage('Saving the agent settings');
				}
			});
			settingsQueue = task;
			return task;
		},

		/** Replaces the list with the matches for `query`; empty restores it. */
		async search(query) {
			const next = query.trim();
			if (next === get().query) return;
			const isCurrent = createSessionWorkGuard();
			if (!isCurrent?.()) return;
			const generation = ++listGeneration;
			set({
				query: next,
				threads: [],
				nextCursor: null,
				tag: undefined,
				status: 'loading',
				loadedPages: 0,
				loadingMore: false,
				loadMoreError: undefined,
			});
			try {
				await loadFirstPage(generation, isCurrent);
			} catch {
				if (isCurrent() && generation === listGeneration)
					set(readFailure('This search'));
			}
		},

		async rename(id, title) {
			try {
				const updated = await renameThread(id, title);
				set(({ threads }) => ({
					// The tag described what the server sent, and this is no longer that.
					tag: undefined,
					threads: threads.map((row) => (row.id === id ? updated : row)),
				}));
			} catch (error) {
				return writeFailure(error, 'This rename');
			}
		},

		async remove(id) {
			try {
				await deleteThread(id);
				set(({ threads }) => ({
					tag: undefined,
					threads: threads.filter((row) => row.id !== id),
				}));
			} catch (error) {
				return writeFailure(error, 'This deletion');
			}
		},

		async removeMany(ids) {
			try {
				const deleted = await bulkDeleteThreads(ids);
				const removed = new Set(deleted);
				set(({ threads }) => ({
					tag: undefined,
					threads: threads.filter((row) => !removed.has(row.id)),
				}));
				return { deleted };
			} catch (error) {
				return {
					deleted: [],
					error: writeFailure(error, 'This bulk deletion'),
				};
			}
		},

		async generateTitle(id, model) {
			try {
				const updated = await generateThreadTitle(id, model);
				set(({ threads }) => ({
					tag: undefined,
					threads: threads.map((row) => (row.id === id ? updated : row)),
				}));
			} catch (error) {
				return writeFailure(error, 'Generating this title');
			}
		},

		/** The optimistic row of a chat that just started; `load` reconciles it. */
		upsertLocal(thread) {
			set(({ threads }) => ({
				tag: undefined,
				threads: [thread, ...threads.filter((row) => row.id !== thread.id)],
			}));
		},

		reset() {
			listGeneration += 1;
			settingsRevision += 1;
			settingsGeneration += 1;
			indexRequest.clear();
			moreInFlight = undefined;
			settingsQueue = Promise.resolve();
			persistedSettings = undefined;
			retrySettingsRead = false;
			settingsLoad = undefined;
			set({
				threads: [],
				catalog: undefined,
				status: 'idle',
				error: undefined,
				tag: undefined,
				nextCursor: null,
				loadingMore: false,
				loadMoreError: undefined,
				loadedPages: 0,
				query: '',
				settings: undefined,
			});
		},
	};
});

/** Reads the index without subscribing, for the system registry's loaders. */
export const agentSnapshot = () => useAgentStore.getState();
