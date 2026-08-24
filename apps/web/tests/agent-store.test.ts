// @vitest-environment happy-dom

import {
	AgentApiError,
	bulkDeleteThreads,
	deleteThread,
	generateThreadTitle,
	listThreads,
	readAgentSettings,
	readCatalog,
	renameThread,
	writeAgentSettings,
} from '@web/lib/agent-api';
import { AGENT_MAX_STEPS } from '@web/lib/agent-settings';
import { useAgentStore } from '@web/lib/agent-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/agent-api', async (importOriginal) => ({
	// The error type is the contract the store branches on, so it stays real.
	AgentApiError: (await importOriginal<typeof import('@web/lib/agent-api')>())
		.AgentApiError,
	bulkDeleteThreads: vi.fn(),
	deleteThread: vi.fn(),
	generateThreadTitle: vi.fn(),
	listThreads: vi.fn(),
	readAgentSettings: vi.fn(),
	readCatalog: vi.fn(),
	renameThread: vi.fn(),
	writeAgentSettings: vi.fn(),
}));

const catalog = { models: [], tools: [] };
const settingsKey = 'personal-agent-settings:v1';
const cursor = { updatedAt: 10, id: '00000000-0000-4000-8000-000000000010' };
const thread = (id: string, updatedAt: number) => ({
	id,
	title: id,
	createdAt: updatedAt,
	updatedAt,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function createMemoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key),
		clear: () => data.clear(),
	};
}

vi.stubGlobal('localStorage', createMemoryStorage());

beforeEach(() => {
	localStorage.clear();
	useAgentStore.getState().reset();
	vi.mocked(readCatalog).mockResolvedValue(catalog);
	vi.mocked(listThreads).mockReset();
	vi.mocked(readAgentSettings).mockReset();
	vi.mocked(writeAgentSettings).mockReset();
	useAgentStore.setState({
		threads: [],
		catalog,
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
});

afterEach(() => vi.clearAllMocks());

describe('agent thread request ordering', () => {
	it('does not start pagination while a first-page refresh is in flight', async () => {
		const refresh = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: typeof cursor;
		}>();
		useAgentStore.setState({
			threads: [thread('known', 20)],
			nextCursor: cursor,
			loadedPages: 1,
			status: 'ready',
		});
		vi.mocked(listThreads).mockReturnValueOnce(refresh.promise);

		const loading = useAgentStore.getState().load(true);
		await useAgentStore.getState().loadMore();

		expect(listThreads).toHaveBeenCalledTimes(1);
		expect(useAgentStore.getState().loadingMore).toBe(false);
		refresh.resolve({ threads: [thread('fresh', 30)], nextCursor: cursor });
		await loading;
	});

	it('ignores an older search response that arrives after the current query', async () => {
		const oldSearch = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: null;
		}>();
		const newSearch = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: null;
		}>();
		vi.mocked(listThreads)
			.mockReturnValueOnce(oldSearch.promise)
			.mockReturnValueOnce(newSearch.promise);

		const first = useAgentStore.getState().search('old');
		const second = useAgentStore.getState().search('current');
		newSearch.resolve({ threads: [thread('current', 2)], nextCursor: null });
		await second;
		oldSearch.resolve({ threads: [thread('old', 1)], nextCursor: null });
		await first;

		expect(useAgentStore.getState().query).toBe('current');
		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'current',
		]);
	});

	it('preserves fully loaded older pages when a first-page refresh has no cursor', async () => {
		vi.mocked(listThreads)
			.mockResolvedValueOnce({
				threads: [thread('new', 30)],
				nextCursor: cursor,
			})
			.mockResolvedValueOnce({
				threads: [thread('old', 10)],
				nextCursor: null,
			})
			.mockResolvedValueOnce({
				threads: [thread('newer', 40)],
				nextCursor: null,
			});

		await useAgentStore.getState().load(true);
		await useAgentStore.getState().loadMore();
		await useAgentStore.getState().load(true);

		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'newer',
			'new',
			'old',
		]);
	});

	it('does not resurrect a thread deleted while a refresh was in flight', async () => {
		const refresh = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: typeof cursor | null;
		}>();
		vi.mocked(listThreads)
			.mockResolvedValueOnce({
				threads: [thread('new', 30)],
				nextCursor: cursor,
			})
			.mockResolvedValueOnce({ threads: [thread('old', 10)], nextCursor: null })
			.mockReturnValueOnce(refresh.promise);
		vi.mocked(deleteThread).mockResolvedValue(undefined);

		await useAgentStore.getState().load(true);
		await useAgentStore.getState().loadMore();

		// A background refresh is travelling when the reader deletes a row that
		// lives on a page the fresh first page will not contain.
		const refreshing = useAgentStore.getState().load(true);
		await useAgentStore.getState().remove('old');
		refresh.resolve({ threads: [thread('new', 30)], nextCursor: cursor });
		await refreshing;

		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'new',
		]);
	});

	it('revalidates a forced refresh with the tag it already holds', async () => {
		vi.mocked(listThreads).mockResolvedValueOnce({
			threads: [thread('known', 20)],
			nextCursor: null,
			tag: 'W/"1"',
		});
		await useAgentStore.getState().load(true);

		vi.mocked(listThreads).mockResolvedValueOnce('unchanged');
		await useAgentStore.getState().load(true);

		expect(vi.mocked(listThreads).mock.calls[1]?.[0]).toMatchObject({
			knownTag: 'W/"1"',
		});
		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'known',
		]);
	});

	it('keeps a newer request deduped when a superseded one settles late', async () => {
		const stale = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: null;
		}>();
		vi.mocked(listThreads).mockReturnValueOnce(stale.promise);

		const abandoned = useAgentStore.getState().load(true);
		useAgentStore.getState().reset();

		const fresh = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: null;
		}>();
		vi.mocked(listThreads).mockReturnValueOnce(fresh.promise);
		const current = useAgentStore.getState().load(true);

		// The abandoned request settling must not release the dedupe slot the
		// live request owns, or a third caller starts a redundant generation.
		stale.resolve({ threads: [thread('stale', 1)], nextCursor: null });
		await abandoned;
		const deduped = useAgentStore.getState().load(true);

		expect(listThreads).toHaveBeenCalledTimes(2);
		fresh.resolve({ threads: [thread('fresh', 2)], nextCursor: null });
		await Promise.all([current, deduped]);
		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'fresh',
		]);
	});
});

describe('agent index session guard', () => {
	it('does not request the index when the session already ended', async () => {
		await useAgentStore.getState().load(true, () => false);

		expect(listThreads).not.toHaveBeenCalled();
		expect(useAgentStore.getState().status).toBe('idle');
	});

	it('does not commit a response that arrives after the session ended', async () => {
		const pull = deferred<{
			threads: ReturnType<typeof thread>[];
			nextCursor: null;
		}>();
		vi.mocked(listThreads).mockReturnValueOnce(pull.promise);
		let current = true;

		const loading = useAgentStore.getState().load(true, () => current);
		current = false;
		pull.resolve({ threads: [thread('late', 1)], nextCursor: null });
		await loading;

		expect(useAgentStore.getState().threads).toEqual([]);
		expect(useAgentStore.getState().status).not.toBe('ready');
	});

	it('does not report a failure that lands after the session ended', async () => {
		const pull = deferred<never>();
		vi.mocked(listThreads).mockReturnValueOnce(pull.promise);
		let current = true;

		const loading = useAgentStore.getState().load(true, () => current);
		current = false;
		pull.reject(new Error('offline'));
		await loading;

		expect(useAgentStore.getState().status).not.toBe('failed');
		expect(useAgentStore.getState().error).toBeUndefined();
	});
});

describe('agent index failure reporting', () => {
	it('separates a lost connection from a server that answered badly', async () => {
		const online = vi.spyOn(navigator, 'onLine', 'get');

		online.mockReturnValue(false);
		vi.mocked(listThreads).mockRejectedValueOnce(new Error('offline'));
		await useAgentStore.getState().load(true);
		expect(useAgentStore.getState().status).toBe('offline');

		online.mockReturnValue(true);
		vi.mocked(listThreads).mockRejectedValueOnce(new AgentApiError(500));
		await useAgentStore.getState().load(true);
		expect(useAgentStore.getState().status).toBe('failed');

		online.mockRestore();
	});

	it('reports a busy thread as busy rather than as an unreachable server', async () => {
		vi.mocked(renameThread).mockRejectedValueOnce(new AgentApiError(409));
		const rename = await useAgentStore.getState().rename('id', 'Title');

		vi.mocked(generateThreadTitle).mockRejectedValueOnce(
			new AgentApiError(409),
		);
		const title = await useAgentStore.getState().generateTitle('id', 'model');

		for (const message of [rename, title]) {
			expect(message).toBeDefined();
			expect(message).not.toMatch(/could not reach|No connection/);
			expect(message).toMatch(/busy/i);
		}
	});
});

describe('agent settings writes', () => {
	it('ignores a settings read that resolves after reset', async () => {
		const read = deferred<{
			selection: { model: string; tools: string[]; maxSteps: number };
		}>();
		vi.mocked(readAgentSettings).mockReturnValueOnce(read.promise);

		const loading = useAgentStore.getState().loadSettings();
		useAgentStore.getState().reset();
		localStorage.removeItem(settingsKey);
		read.resolve({
			selection: { model: 'old-session', tools: [], maxSteps: 99 },
		});
		await loading;

		expect(useAgentStore.getState().settings).toBeUndefined();
		expect(localStorage.getItem(settingsKey)).toBeNull();
		expect(writeAgentSettings).not.toHaveBeenCalled();
	});

	it('does not let an old read completion suppress the new session retry', async () => {
		const oldRead = deferred<{ titleModel: string }>();
		vi.mocked(readAgentSettings)
			.mockReturnValueOnce(oldRead.promise)
			.mockRejectedValueOnce(new Error('new session offline'))
			.mockResolvedValueOnce({ titleModel: 'new-title' });
		vi.mocked(writeAgentSettings).mockResolvedValueOnce({
			titleModel: 'new-title',
			compactionModel: 'new-compact',
		});

		const oldLoading = useAgentStore.getState().loadSettings();
		useAgentStore.getState().reset();
		await useAgentStore.getState().loadSettings();
		oldRead.resolve({ titleModel: 'old-title' });
		await oldLoading;

		await useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'new-compact' });

		expect(readAgentSettings).toHaveBeenCalledTimes(3);
		expect(writeAgentSettings).toHaveBeenCalledWith({
			titleModel: 'new-title',
			compactionModel: 'new-compact',
		});
	});

	it('skips queued writes after reset and does not poison the next session', async () => {
		const firstWrite = deferred<{
			selection: { model: string; tools: string[]; maxSteps: number };
		}>();
		vi.mocked(writeAgentSettings)
			.mockReturnValueOnce(firstWrite.promise)
			.mockResolvedValueOnce({
				titleModel: 'new-session',
				compactionModel: 'compact-new',
			});
		useAgentStore.setState({
			settings: {
				selection: { model: 'old-session', tools: [], maxSteps: 5 },
			},
		});

		const started = useAgentStore.getState().saveSettings({
			selection: { model: 'old-write', tools: ['tavily'], maxSteps: 99 },
		});
		await vi.waitFor(() => expect(writeAgentSettings).toHaveBeenCalledTimes(1));
		const queued = useAgentStore
			.getState()
			.saveSettings({ titleModel: 'old-title' });

		useAgentStore.getState().reset();
		localStorage.removeItem(settingsKey);
		firstWrite.resolve({
			selection: { model: 'old-write', tools: ['tavily'], maxSteps: 99 },
		});
		await started;
		await queued;

		expect(writeAgentSettings).toHaveBeenCalledTimes(1);
		expect(useAgentStore.getState().settings).toBeUndefined();
		expect(localStorage.getItem(settingsKey)).toBeNull();

		useAgentStore.setState({ settings: { titleModel: 'new-session' } });
		await useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'compact-new' });
		expect(writeAgentSettings).toHaveBeenLastCalledWith({
			titleModel: 'new-session',
			compactionModel: 'compact-new',
		});
	});

	it('discards an in-flight seed completion after reset', async () => {
		localStorage.setItem(
			settingsKey,
			JSON.stringify({
				version: 1,
				selection: { model: 'old-local', tools: [], maxSteps: 5 },
			}),
		);
		const seedWrite = deferred<{
			selection: { model: string; tools: string[]; maxSteps: number };
			titleModel: string;
		}>();
		vi.mocked(readAgentSettings).mockResolvedValueOnce(null);
		vi.mocked(writeAgentSettings)
			.mockReturnValueOnce(seedWrite.promise)
			.mockResolvedValueOnce({ compactionModel: 'new-compact' });

		const seeding = useAgentStore.getState().loadSettings();
		await vi.waitFor(() => expect(writeAgentSettings).toHaveBeenCalledTimes(1));
		useAgentStore.getState().reset();
		localStorage.removeItem(settingsKey);
		seedWrite.resolve({
			selection: { model: 'old-local', tools: [], maxSteps: 5 },
			titleModel: 'old-title',
		});
		await seeding;

		useAgentStore.setState({ settings: {} });
		await useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'new-compact' });

		expect(writeAgentSettings).toHaveBeenLastCalledWith({
			compactionModel: 'new-compact',
		});
	});

	it('uses the local mirror when the initial shared read is offline', async () => {
		localStorage.setItem(
			settingsKey,
			JSON.stringify({
				version: 1,
				selection: { model: 'local', tools: [], maxSteps: 99 },
			}),
		);
		vi.mocked(readAgentSettings).mockRejectedValueOnce(new Error('offline'));

		await useAgentStore.getState().loadSettings();

		expect(useAgentStore.getState().settings).toEqual({
			selection: { model: 'local', tools: [], maxSteps: 99 },
		});
	});

	it('adopts the shared copy and mirrors it locally', async () => {
		vi.mocked(readAgentSettings).mockResolvedValueOnce({
			selection: { model: 'shared', tools: [], maxSteps: 99 },
			titleModel: 'title-a',
		});

		await useAgentStore.getState().loadSettings();

		expect(useAgentStore.getState().settings).toEqual({
			selection: { model: 'shared', tools: [], maxSteps: 99 },
			titleModel: 'title-a',
		});
		expect(JSON.parse(localStorage.getItem(settingsKey) ?? '')).toEqual({
			version: 1,
			selection: { model: 'shared', tools: [], maxSteps: 99 },
			titleModel: 'title-a',
		});
	});

	it('seeds a missing shared copy from the legacy selection', async () => {
		// A mirror written before the ceiling existed: the migration carries the
		// model and tools forward and pins the step count rather than discarding
		// choices over a field the composer can no longer even express.
		localStorage.setItem(
			'personal-agent:v1',
			JSON.stringify({
				selection: { model: 'legacy', tools: ['tavily'], maxSteps: 1000 },
			}),
		);
		const seeded = {
			selection: {
				model: 'legacy',
				tools: ['tavily'],
				maxSteps: AGENT_MAX_STEPS,
			},
		};
		vi.mocked(readAgentSettings).mockResolvedValueOnce(null);
		vi.mocked(writeAgentSettings).mockResolvedValueOnce(seeded);

		await useAgentStore.getState().loadSettings();

		expect(writeAgentSettings).toHaveBeenCalledWith(seeded);
		expect(useAgentStore.getState().settings).toEqual(seeded);
	});

	it('exposes an empty object when neither shared nor local settings exist', async () => {
		vi.mocked(readAgentSettings).mockResolvedValueOnce(null);

		await useAgentStore.getState().loadSettings();

		expect(useAgentStore.getState().settings).toEqual({});
		expect(writeAgentSettings).not.toHaveBeenCalled();
	});

	it('retries the settings read after an initial rejection', async () => {
		vi.mocked(readAgentSettings)
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ titleModel: 'title-a' });
		vi.mocked(writeAgentSettings).mockResolvedValueOnce({
			titleModel: 'title-a',
			compactionModel: 'compact-b',
		});

		await useAgentStore.getState().loadSettings();
		const failure = await useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'compact-b' });

		expect(failure).toBeUndefined();
		expect(readAgentSettings).toHaveBeenCalledTimes(2);
		expect(writeAgentSettings).toHaveBeenCalledWith({
			titleModel: 'title-a',
			compactionModel: 'compact-b',
		});
	});

	it('shares a pending initial read with an immediate save', async () => {
		const initialRead = deferred<{ titleModel: string } | null>();
		vi.mocked(readAgentSettings).mockReturnValueOnce(initialRead.promise);
		vi.mocked(writeAgentSettings).mockResolvedValueOnce({
			titleModel: 'title-a',
			compactionModel: 'compact-b',
		});

		const load = useAgentStore.getState().loadSettings();
		const save = useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'compact-b' });
		initialRead.resolve({ titleModel: 'title-a' });
		await load;
		await save;

		expect(readAgentSettings).toHaveBeenCalledTimes(1);
		expect(writeAgentSettings).toHaveBeenCalledWith({
			titleModel: 'title-a',
			compactionModel: 'compact-b',
		});
	});

	it('preserves the legacy selection when the first save races a null read', async () => {
		localStorage.setItem(
			'personal-agent:v1',
			JSON.stringify({
				selection: { model: 'legacy', tools: ['tavily'], maxSteps: 99 },
			}),
		);
		const initialRead = deferred<null>();
		vi.mocked(readAgentSettings).mockReturnValueOnce(initialRead.promise);
		vi.mocked(writeAgentSettings).mockResolvedValueOnce({
			selection: { model: 'legacy', tools: ['tavily'], maxSteps: 99 },
			titleModel: 'title-a',
		});

		const load = useAgentStore.getState().loadSettings();
		const save = useAgentStore
			.getState()
			.saveSettings({ titleModel: 'title-a' });
		initialRead.resolve(null);
		await load;
		await save;

		expect(writeAgentSettings).toHaveBeenCalledWith({
			selection: { model: 'legacy', tools: ['tavily'], maxSteps: 99 },
			titleModel: 'title-a',
		});
	});

	it('serializes saves so an older response cannot overwrite a newer choice', async () => {
		useAgentStore.setState({
			settings: {
				selection: { model: 'model-a', tools: [], maxSteps: 99 },
			},
		});
		const firstWrite = deferred<{ titleModel: string }>();
		vi.mocked(writeAgentSettings)
			.mockReturnValueOnce(firstWrite.promise)
			.mockResolvedValueOnce({
				titleModel: 'title-a',
			})
			.mockResolvedValueOnce({
				titleModel: 'title-a',
				compactionModel: 'compact-b',
			});

		const first = useAgentStore.getState().saveSettings({
			selection: { model: 'model-b', tools: ['tavily'], maxSteps: 1000 },
		});
		const second = useAgentStore
			.getState()
			.saveSettings({ titleModel: 'title-a' });
		const third = useAgentStore
			.getState()
			.saveSettings({ compactionModel: 'compact-b' });

		await vi.waitFor(() => expect(writeAgentSettings).toHaveBeenCalledTimes(1));
		firstWrite.resolve({ titleModel: 'title-a' });
		await first;
		await second;
		await third;

		expect(vi.mocked(writeAgentSettings).mock.calls).toEqual([
			[
				{
					selection: {
						model: 'model-b',
						tools: ['tavily'],
						maxSteps: 1000,
					},
				},
			],
			[
				{
					selection: {
						model: 'model-b',
						tools: ['tavily'],
						maxSteps: 1000,
					},
					titleModel: 'title-a',
				},
			],
			[
				{
					selection: {
						model: 'model-b',
						tools: ['tavily'],
						maxSteps: 1000,
					},
					titleModel: 'title-a',
					compactionModel: 'compact-b',
				},
			],
		]);
		expect(useAgentStore.getState().settings).toEqual({
			selection: {
				model: 'model-b',
				tools: ['tavily'],
				maxSteps: 1000,
			},
			titleModel: 'title-a',
			compactionModel: 'compact-b',
		});
	});

	it('keeps state and the local mirror when the shared write fails', async () => {
		const initial = {
			selection: { model: 'model-a', tools: [], maxSteps: 5 },
			titleModel: 'title-a',
		};
		localStorage.setItem(
			settingsKey,
			JSON.stringify({ version: 1, ...initial }),
		);
		useAgentStore.setState({ settings: initial });
		vi.mocked(writeAgentSettings).mockRejectedValueOnce(new Error('offline'));

		const failure = await useAgentStore.getState().saveSettings({
			selection: { model: 'model-b', tools: ['tavily'], maxSteps: 1000 },
		});

		expect(failure).toMatch(/saving/i);
		expect(useAgentStore.getState().settings).toEqual({
			selection: { model: 'model-b', tools: ['tavily'], maxSteps: 1000 },
			titleModel: 'title-a',
		});
		expect(JSON.parse(localStorage.getItem(settingsKey) ?? '')).toEqual({
			version: 1,
			selection: { model: 'model-b', tools: ['tavily'], maxSteps: 1000 },
			titleModel: 'title-a',
		});
	});
});

describe('agent thread mutations', () => {
	it('installs a generated title in the index', async () => {
		useAgentStore.setState({ threads: [thread('thread-a', 1)] });
		vi.mocked(generateThreadTitle).mockResolvedValueOnce({
			...thread('thread-a', 2),
			title: 'Generated title',
		});

		await expect(
			useAgentStore.getState().generateTitle('thread-a', 'fallback-model'),
		).resolves.toBeUndefined();
		expect(useAgentStore.getState().threads[0]?.title).toBe('Generated title');
	});

	it('removes only the ids confirmed by one bulk response', async () => {
		useAgentStore.setState({
			threads: [
				thread('thread-a', 3),
				thread('thread-b', 2),
				thread('thread-c', 1),
			],
		});
		vi.mocked(bulkDeleteThreads).mockResolvedValueOnce([
			'thread-a',
			'thread-c',
		]);

		await expect(
			useAgentStore.getState().removeMany(['thread-a', 'thread-b', 'thread-c']),
		).resolves.toEqual({ deleted: ['thread-a', 'thread-c'] });
		expect(bulkDeleteThreads).toHaveBeenCalledTimes(1);
		expect(useAgentStore.getState().threads.map(({ id }) => id)).toEqual([
			'thread-b',
		]);
	});

	it('keeps every row when the bulk request fails', async () => {
		useAgentStore.setState({
			threads: [thread('thread-a', 2), thread('thread-b', 1)],
		});
		vi.mocked(bulkDeleteThreads).mockRejectedValueOnce(new Error('offline'));

		const result = await useAgentStore
			.getState()
			.removeMany(['thread-a', 'thread-b']);
		expect(result.deleted).toEqual([]);
		expect(result.error).toMatch(/deletion/i);
		expect(useAgentStore.getState().threads).toHaveLength(2);
	});
});
