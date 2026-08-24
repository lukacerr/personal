// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSettings } from '@web/lib/agent-api';
import Agent from '@web/routes/_app.agent';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	compactThread: vi.fn(),
	createThread: vi.fn(),
	deleteThread: vi.fn(),
	readThreadMessages: vi.fn(),
	searchThread: vi.fn(),
	preflightResult: vi.fn(),
}));

const media = vi.hoisted(() => ({
	desktop: true,
	listeners: new Set<() => void>(),
}));

const store = vi.hoisted(() => {
	const state = {
		threads: [],
		catalog: {
			models: [
				{
					id: 'model',
					provider: 'test',
					label: 'Model',
					reasoning: { levels: ['off'], default: 'off' },
				},
			],
			tools: [],
		},
		status: 'ready',
		error: undefined,
		nextCursor: null,
		loadingMore: false,
		loadMoreError: undefined,
		loadedPages: 1,
		query: '',
		settings: {
			selection: { model: 'model', reasoning: 'off', tools: [], maxSteps: 99 },
		} as AgentSettings,
		load: vi.fn(),
		loadMore: vi.fn(),
		search: vi.fn(),
		rename: vi.fn(),
		remove: vi.fn(),
		removeMany: vi.fn(),
		generateTitle: vi.fn(),
		loadSettings: vi.fn(),
		saveSettings: vi.fn(),
		upsertLocal: vi.fn(),
	};
	const useStore = Object.assign(
		(selector: (value: typeof state) => unknown) => selector(state),
		{ getState: () => state },
	);
	return { state, useStore };
});

vi.mock('@web/lib/agent-api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@web/lib/agent-api')>()),
	compactThread: api.compactThread,
	createThread: api.createThread,
	deleteThread: api.deleteThread,
	readThreadMessages: api.readThreadMessages,
	searchThread: api.searchThread,
}));

vi.mock('@web/lib/agent-store', () => ({ useAgentStore: store.useStore }));
vi.mock('@web/lib/agent-preferences', () => ({
	useAgentPreferences: () => ({
		preferences: { fontSize: 'medium', margins: 'medium' },
		setPreference: vi.fn(),
	}),
}));
vi.mock('@web/lib/create-param', () => ({ useConsumeCreateParam: vi.fn() }));
vi.mock('@web/components/agent/agent-thread-rail', () => ({
	AgentThreadRail: ({
		onSelect,
		onNew,
		onGenerateTitle,
		onSelectionChange,
		onDeleteSelected,
		interactionBusy,
		selected,
	}: {
		onSelect: (id: string) => void;
		onNew: () => void;
		onGenerateTitle: (thread: { id: string; title: string }) => void;
		onSelectionChange: (selected: Set<string>) => void;
		onDeleteSelected: () => void;
		interactionBusy: boolean;
		selected: Set<string>;
	}) => (
		<div>
			<span>Rail selected {selected.size}</span>
			<button
				type="button"
				disabled={interactionBusy}
				onClick={() => onSelect('thread-b')}
			>
				Open thread B
			</button>
			<button type="button" onClick={() => onSelect('thread-b')}>
				Force open thread B
			</button>
			<button type="button" onClick={onNew}>
				Force new chat
			</button>
			<button
				type="button"
				onClick={() => onGenerateTitle({ id: 'thread-a', title: 'Thread A' })}
			>
				Generate title A
			</button>
			<button
				type="button"
				onClick={() => onSelectionChange(new Set(['thread-a', 'thread-b']))}
			>
				Select A and B
			</button>
			<button type="button" onClick={onDeleteSelected}>
				Delete selected
			</button>
		</div>
	),
}));
vi.mock('@web/components/agent/agent-chat', () => ({
	AgentChat: ({
		chatId,
		onBusyChange,
		compactionMessage,
		edgeRequest,
		ensureThread,
		busyReason,
	}: {
		chatId: string;
		onBusyChange?: (busy: boolean) => void;
		compactionMessage?: { id: string };
		edgeRequest?: { edge: string; token: number };
		ensureThread: (text: string) => Promise<unknown>;
		busyReason?: string;
	}) => (
		<div>
			<span>Chat {chatId}</span>
			{busyReason ? <span>Sending blocked: {busyReason}</span> : null}
			{edgeRequest ? (
				<span>
					Edge {edgeRequest.edge} {edgeRequest.token}
				</span>
			) : null}
			<button type="button" onClick={() => onBusyChange?.(true)}>
				Start turn
			</button>
			<button
				type="button"
				onClick={() =>
					void ensureThread('draft text').then(api.preflightResult)
				}
			>
				Run preflight
			</button>
			{compactionMessage ? (
				<span>Compaction {compactionMessage.id}</span>
			) : null}
		</div>
	),
}));
vi.mock('@web/components/agent/agent-thread-finder', () => ({
	AgentThreadFinder: ({
		matches,
		hasMore,
		loadingMore,
		onSearch,
		onLoadMore,
	}: {
		matches: { id: string }[];
		hasMore: boolean;
		loadingMore: boolean;
		onSearch: (query: string) => void;
		onLoadMore: () => void;
	}) => (
		<div>
			<button type="button" onClick={() => onSearch('old')}>
				Search old
			</button>
			<button type="button" onClick={() => onSearch('current')}>
				Search current
			</button>
			{matches.map((match) => (
				<span key={match.id}>{match.id}</span>
			))}
			{loadingMore ? <span>Loading more search results</span> : null}
			{hasMore ? (
				<button type="button" onClick={onLoadMore}>
					More search results
				</button>
			) : null}
		</div>
	),
}));
vi.mock('@web/components/agent/agent-preferences', () => ({
	AgentPreferencesControl: () => null,
}));
vi.mock('@web/components/agent/agent-dialogs', () => ({
	ThreadBulkDeleteDialog: ({
		count,
		error,
		onConfirm,
	}: {
		count: number;
		error?: string;
		onConfirm: () => void;
	}) =>
		count > 0 ? (
			<div role="dialog">
				<span>Delete {count} conversations?</span>
				{error ? <span>{error}</span> : null}
				<button type="button" onClick={onConfirm}>
					Confirm bulk delete
				</button>
			</div>
		) : null,
	ThreadDeleteDialog: () => null,
	ThreadRenameDialog: () => null,
}));

const page = (id: string) => ({
	messages: [{ id: `message-${id}`, role: 'user', parts: [] }],
	oldest: 1,
	newest: 1,
	hasOlder: false,
	hasNewer: false,
});

function HistoryNavigation() {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate('/agent?thread=thread-b')}>
			History to B
		</button>
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
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

beforeEach(() => {
	// This environment ships no localStorage, and the route remembers the open
	// conversation in it.
	vi.stubGlobal('localStorage', createMemoryStorage());
	media.desktop = true;
	media.listeners.clear();
	vi.stubGlobal('matchMedia', (query: string) => ({
		get matches() {
			return query.includes('1024') ? media.desktop : false;
		},
		media: query,
		addEventListener: (_event: string, listener: () => void) =>
			media.listeners.add(listener),
		removeEventListener: (_event: string, listener: () => void) =>
			media.listeners.delete(listener),
	}));
	api.compactThread.mockReset();
	api.createThread.mockReset();
	api.deleteThread.mockReset().mockResolvedValue(undefined);
	api.preflightResult.mockReset();
	api.searchThread.mockReset();
	api.readThreadMessages
		.mockReset()
		.mockImplementation((id: string) => Promise.resolve(page(id)));
	store.state.generateTitle.mockReset().mockResolvedValue(undefined);
	store.state.saveSettings.mockReset().mockResolvedValue(undefined);
	store.state.settings = {
		selection: { model: 'model', reasoning: 'off', tools: [], maxSteps: 99 },
	};
	store.state.upsertLocal.mockReset();
	store.state.removeMany
		.mockReset()
		.mockResolvedValue({ deleted: ['thread-a', 'thread-b'] });
});

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

describe('Agent route operations', () => {
	function setDesktop(desktop: boolean) {
		media.desktop = desktop;
		for (const listener of media.listeners) listener();
	}

	it('opens conversations in a sheet below the lg rail breakpoint', async () => {
		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: !query.includes('1024'),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		expect(
			screen.getAllByRole('button', { name: 'Open thread B' }),
		).toHaveLength(1);

		await userEvent.click(
			screen.getByRole('button', { name: 'Conversations' }),
		);

		const dialog = await screen.findByRole('dialog');
		expect(
			within(dialog).getByRole('button', { name: 'Open thread B' }),
		).toBeDefined();
	});

	it('uses catalog defaults without overwriting a shared empty settings object', async () => {
		const previous = store.state.settings;
		store.state.settings = {};
		try {
			render(
				<MemoryRouter initialEntries={['/agent?new=1']}>
					<Agent />
				</MemoryRouter>,
			);
			await screen.findByText(/^Chat /);
			expect(store.state.saveSettings).not.toHaveBeenCalled();
		} finally {
			store.state.settings = previous;
		}
	});

	it('does not compact while the mounted chat reports an active turn', async () => {
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(screen.getByRole('button', { name: 'Start turn' }));

		expect(
			screen
				.getByRole('button', { name: 'Compact context' })
				.hasAttribute('disabled'),
		).toBe(true);
		await userEvent.click(
			screen.getByRole('button', { name: 'Compact context' }),
		);
		expect(api.compactThread).not.toHaveBeenCalled();
	});

	/**
	 * The mirror of the test above: the lease belongs to whoever took it first,
	 * so a compaction has to stop the chat from sending exactly as an active
	 * turn stops the compaction.
	 */
	it('blocks sending in the mounted chat while a compaction runs', async () => {
		const compacting = deferred<{
			id: string;
			role: 'assistant';
			parts: { type: 'text'; text: string }[];
		}>();
		api.compactThread.mockReturnValueOnce(compacting.promise);
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		expect(screen.queryByText(/^Sending blocked/)).toBeNull();

		await userEvent.click(
			screen.getByRole('button', { name: 'Compact context' }),
		);
		expect(await screen.findByText(/^Sending blocked/)).toBeDefined();

		compacting.resolve({
			id: 'compaction-a',
			role: 'assistant',
			parts: [{ type: 'text', text: 'summary' }],
		});
		await waitFor(() =>
			expect(screen.queryByText(/^Sending blocked/)).toBeNull(),
		);
	});

	it('guards rail navigation and new chat while a turn is busy', async () => {
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(screen.getByRole('button', { name: 'Start turn' }));
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Force open thread B' })[0],
		);
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Force new chat' })[0],
		);
		expect(screen.getByText('Chat thread-a')).toBeDefined();
	});

	it('cancels and deletes a draft created after history navigation made preflight stale', async () => {
		const creation = deferred<{
			id: string;
			title: string;
			createdAt: number;
			updatedAt: number;
		}>();
		api.createThread.mockReturnValueOnce(creation.promise);
		render(
			<MemoryRouter initialEntries={['/agent?new=1']}>
				<HistoryNavigation />
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText(/^Chat /);
		await userEvent.click(
			screen.getByRole('button', { name: 'Run preflight' }),
		);
		await userEvent.click(screen.getByRole('button', { name: 'History to B' }));
		await screen.findByText('Chat thread-b');
		creation.resolve({
			id: 'draft-created-stale',
			title: 'New chat',
			createdAt: 1,
			updatedAt: 1,
		});

		await waitFor(() =>
			expect(api.deleteThread).toHaveBeenCalledWith('draft-created-stale'),
		);
		expect(store.state.upsertLocal).not.toHaveBeenCalled();
		expect(api.preflightResult).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(screen.getByText('Chat thread-b')).toBeDefined();
	});

	it('clears bulk selection when history changes the selected thread', async () => {
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<HistoryNavigation />
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Select A and B' })[0],
		);
		expect(screen.getAllByText('Rail selected 2').length).toBeGreaterThan(0);
		await userEvent.click(screen.getByRole('button', { name: 'History to B' }));
		await screen.findByText('Chat thread-b');
		expect(screen.getAllByText('Rail selected 0').length).toBeGreaterThan(0);
	});

	it('generates a row title with the current selection model and blocks it while that chat is busy', async () => {
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Generate title A' })[0],
		);
		expect(store.state.generateTitle).toHaveBeenCalledWith('thread-a', 'model');

		await userEvent.click(screen.getByRole('button', { name: 'Start turn' }));
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Generate title A' })[0],
		);
		expect(store.state.generateTitle).toHaveBeenCalledTimes(1);
	});

	it('confirms one bulk request and opens a draft when the selected current thread is deleted', async () => {
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Select A and B' })[0],
		);
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Delete selected' })[0],
		);
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Delete 2 conversations?')).toBeDefined();
		await userEvent.click(
			within(dialog).getByRole('button', { name: 'Confirm bulk delete' }),
		);
		expect(store.state.removeMany).toHaveBeenCalledTimes(1);
		expect(store.state.removeMany).toHaveBeenCalledWith([
			'thread-a',
			'thread-b',
		]);
		await waitFor(() => expect(screen.queryByText('Chat thread-a')).toBeNull());
	});

	it('keeps the failed bulk selection and error dialog open', async () => {
		store.state.removeMany.mockResolvedValueOnce({
			deleted: [],
			error: 'This bulk deletion failed.',
		});
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Select A and B' })[0],
		);
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Delete selected' })[0],
		);
		await userEvent.click(
			within(await screen.findByRole('dialog')).getByRole('button', {
				name: 'Confirm bulk delete',
			}),
		);
		expect(await screen.findByText('This bulk deletion failed.')).toBeDefined();
		expect(screen.getByText('Delete 2 conversations?')).toBeDefined();
	});

	it('does not install a compaction result after navigation to another thread', async () => {
		const compacting = deferred<{
			id: string;
			role: 'assistant';
			parts: { type: 'text'; text: string }[];
		}>();
		api.compactThread.mockReturnValueOnce(compacting.promise);
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getByRole('button', { name: 'Compact context' }),
		);
		await userEvent.click(
			screen.getAllByRole('button', { name: 'Open thread B' })[0],
		);
		await screen.findByText('Chat thread-b');

		compacting.resolve({
			id: 'compaction-a',
			role: 'assistant',
			parts: [{ type: 'text', text: 'summary' }],
		});
		await waitFor(() => expect(api.compactThread).toHaveBeenCalledTimes(1));
		expect(screen.getByText('Chat thread-b')).toBeDefined();
		expect(screen.queryByText('Chat thread-a')).toBeNull();
	});

	it('restores the remembered thread only when the url asks for nothing', async () => {
		const remember = () =>
			localStorage.setItem(
				'personal-agent:v1',
				JSON.stringify({ thread: 'thread-a' }),
			);

		// A url that names a thread wins over what this device remembers.
		remember();
		const named = render(
			<MemoryRouter initialEntries={['/agent?thread=thread-b']}>
				<Agent />
			</MemoryRouter>,
		);
		expect(await screen.findByText('Chat thread-b')).toBeDefined();
		named.unmount();

		// The palette's "new chat" is an intent of its own: it opens a draft
		// instead of reopening what was last read.
		remember();
		const fresh = render(
			<MemoryRouter initialEntries={['/agent?new=1']}>
				<Agent />
			</MemoryRouter>,
		);
		await waitFor(() => expect(screen.queryByText('Chat thread-a')).toBeNull());
		fresh.unmount();

		// A bare url is the only case that reopens the remembered conversation.
		remember();
		render(
			<MemoryRouter initialEntries={['/agent']}>
				<Agent />
			</MemoryRouter>,
		);
		expect(await screen.findByText('Chat thread-a')).toBeDefined();
	});

	it('does not replay a thread command in the next conversation opened', async () => {
		api.compactThread.mockResolvedValueOnce({
			id: 'compaction-a',
			role: 'assistant',
			parts: [{ type: 'text', text: 'summary' }],
		});
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');

		// Both commands belong to thread A: one edge jump and one compaction.
		fireEvent.keyDown(window, {
			key: 'ArrowUp',
			ctrlKey: true,
			shiftKey: true,
		});
		await userEvent.click(
			screen.getByRole('button', { name: 'Compact context' }),
		);
		expect(await screen.findByText('Edge start 1')).toBeDefined();
		expect(await screen.findByText('Compaction compaction-a')).toBeDefined();

		await userEvent.click(
			screen.getAllByRole('button', { name: 'Open thread B' })[0],
		);
		await screen.findByText('Chat thread-b');

		// Thread B produced neither, so it must open at its newest messages with
		// no marker appended.
		expect(screen.queryByText(/^Edge /)).toBeNull();
		expect(screen.queryByText(/^Compaction /)).toBeNull();
	});

	it('delivers compaction to the mounted chat without reloading its session', async () => {
		api.compactThread.mockResolvedValueOnce({
			id: 'compaction-a',
			role: 'assistant',
			parts: [{ type: 'text', text: 'summary' }],
		});
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		expect(api.readThreadMessages).toHaveBeenCalledTimes(1);

		await userEvent.click(
			screen.getByRole('button', { name: 'Compact context' }),
		);

		expect(await screen.findByText('Compaction compaction-a')).toBeDefined();
		expect(api.readThreadMessages).toHaveBeenCalledTimes(1);
	});

	it('ignores an older in-thread search response that resolves last', async () => {
		const oldSearch = deferred<{
			matches: {
				id: string;
				position: number;
				role: string;
				snippet: string;
			}[];
			nextCursor: null;
		}>();
		const currentSearch = deferred<{
			matches: {
				id: string;
				position: number;
				role: string;
				snippet: string;
			}[];
			nextCursor: null;
		}>();
		api.searchThread
			.mockReturnValueOnce(oldSearch.promise)
			.mockReturnValueOnce(currentSearch.promise);
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(screen.getByRole('button', { name: 'Search old' }));
		await userEvent.click(
			screen.getByRole('button', { name: 'Search current' }),
		);
		currentSearch.resolve({
			matches: [
				{ id: 'current-match', position: 2, role: 'user', snippet: '' },
			],
			nextCursor: null,
		});
		await screen.findByText('current-match');
		oldSearch.resolve({
			matches: [{ id: 'old-match', position: 1, role: 'user', snippet: '' }],
			nextCursor: null,
		});

		await waitFor(() => expect(screen.queryByText('old-match')).toBeNull());
		expect(screen.getByText('current-match')).toBeDefined();
	});

	it('appends another finder page using the returned cursor', async () => {
		api.searchThread
			.mockResolvedValueOnce({
				matches: [{ id: 'match-2', position: 20, role: 'user', snippet: '' }],
				nextCursor: 20,
			})
			.mockResolvedValueOnce({
				matches: [
					{ id: 'match-1', position: 10, role: 'assistant', snippet: '' },
				],
				nextCursor: null,
			});
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getByRole('button', { name: 'Search current' }),
		);
		await screen.findByText('match-2');
		await userEvent.click(
			screen.getByRole('button', { name: 'More search results' }),
		);

		await screen.findByText('match-1');
		expect(screen.getByText('match-2')).toBeDefined();
		expect(api.searchThread).toHaveBeenLastCalledWith('thread-a', 'current', {
			before: 20,
		});
	});

	it('clears stale finder loading when a new search starts', async () => {
		const more = deferred<{
			matches: {
				id: string;
				position: number;
				role: string;
				snippet: string;
			}[];
			nextCursor: null;
		}>();
		api.searchThread
			.mockResolvedValueOnce({
				matches: [{ id: 'match-2', position: 20, role: 'user', snippet: '' }],
				nextCursor: 20,
			})
			.mockReturnValueOnce(more.promise)
			.mockResolvedValueOnce({ matches: [], nextCursor: null });
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getByRole('button', { name: 'Search current' }),
		);
		await screen.findByText('match-2');
		await userEvent.click(
			screen.getByRole('button', { name: 'More search results' }),
		);
		expect(screen.getByText('Loading more search results')).toBeDefined();

		await userEvent.click(screen.getByRole('button', { name: 'Search old' }));

		expect(screen.queryByText('Loading more search results')).toBeNull();
		more.resolve({ matches: [], nextCursor: null });
	});

	it('does not reopen a drawer after crossing through desktop', async () => {
		media.desktop = false;
		render(
			<MemoryRouter initialEntries={['/agent?thread=thread-a']}>
				<Agent />
			</MemoryRouter>,
		);
		await screen.findByText('Chat thread-a');
		await userEvent.click(
			screen.getByRole('button', { name: 'Conversations' }),
		);
		expect(await screen.findByRole('dialog')).toBeDefined();

		setDesktop(true);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		setDesktop(false);

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
});
