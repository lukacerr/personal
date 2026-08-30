import {
	AgentChat,
	type AgentEnsureThreadResult,
} from '@web/components/agent/agent-chat';
import {
	ThreadBulkDeleteDialog,
	ThreadDeleteDialog,
	ThreadRenameDialog,
} from '@web/components/agent/agent-dialogs';
import { AgentPreferencesControl } from '@web/components/agent/agent-preferences';
import { AgentThreadFinder } from '@web/components/agent/agent-thread-finder';
import {
	AgentThreadRail,
	MAX_BULK_SELECTION,
} from '@web/components/agent/agent-thread-rail';
import { Button } from '@web/components/ui/button';
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@web/components/ui/sheet';
import { Spinner } from '@web/components/ui/spinner';
import {
	type AgentSelection,
	draftThreadTitle,
	isAgentRailShortcut,
	isNewChatShortcut,
	isNextUserMessageShortcut,
	isPreviousUserMessageShortcut,
	isThreadEndShortcut,
	isThreadFindShortcut,
	isThreadStartShortcut,
	jumpToUserMessage,
	readAgentLocal,
	rememberThread,
	restoreSelection,
} from '@web/lib/agent';
import {
	AgentApiError,
	type AgentMessagePage,
	type AgentSearchMatch,
	type AgentSettings,
	type AgentThread,
	type AgentUIMessage,
	compactThread,
	createThread,
	forkThread,
	readThreadMessages,
	searchThread,
} from '@web/lib/agent-api';
import { useAgentPreferences } from '@web/lib/agent-preferences';
import {
	dropRun,
	isThreadRunning,
	liveRun,
	runningThreads,
	subscribeRuns,
} from '@web/lib/agent-runs';
import { useAgentStore } from '@web/lib/agent-store';
import { isTransientApiFailure } from '@web/lib/api';
import { useConsumeCreateParam } from '@web/lib/create-param';
import {
	ArrowDownIcon,
	ArrowUpIcon,
	FoldVerticalIcon,
	MessagesSquareIcon,
	PlusIcon,
} from 'lucide-react';
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

export function meta() {
	return [{ title: 'Agent · Personal' }];
}

/** What one mounted conversation needs; keyed by `chatId` in the tree. */
type ChatSession = {
	chatId: string;
	initialMessages: AgentUIMessage[];
	/** Where that page sits in the thread, so either end can be walked to. */
	window: Omit<AgentMessagePage, 'messages'>;
	/** A draft has no server row yet; its first send creates one, same id. */
	isDraft: boolean;
	generation: number;
};

const EMPTY_WINDOW = {
	oldest: null,
	newest: null,
	hasOlder: false,
	hasNewer: false,
};

const cancelledSend = (): AgentEnsureThreadResult => ({
	status: 'cancelled',
	message: 'Send canceled because this conversation is no longer open.',
});

/** One frozen array, so the server snapshot never looks like a change. */
const emptyRunning: readonly string[] = [];

const AGENT_DESKTOP_RAIL_QUERY = '(min-width: 1024px)';
const subscribeToAgentRail = (notify: () => void) => {
	const query = window.matchMedia(AGENT_DESKTOP_RAIL_QUERY);
	query.addEventListener('change', notify);
	return () => query.removeEventListener('change', notify);
};
const agentRailIsDesktop = () =>
	window.matchMedia(AGENT_DESKTOP_RAIL_QUERY).matches;
const agentRailServerSnapshot = () => false;

export default function Agent() {
	const [searchParams, setSearchParams] = useSearchParams();
	const selectedId = searchParams.get('thread') ?? undefined;

	/**
	 * Which conversation the url points at. Always `replace`: opening one from
	 * the rail is not a place to come back to with Back, and every writer here
	 * agreed on that separately before this was one function.
	 */
	const setThreadParam = useCallback(
		(id: string | undefined) =>
			setSearchParams(
				(current) => {
					const next = new URLSearchParams(current);
					if (id) next.set('thread', id);
					else next.delete('thread');
					return next;
				},
				{ replace: true },
			),
		[setSearchParams],
	);

	/**
	 * One selector per field rather than the whole store: subscribing to the
	 * entire state re-rendered this screen — rail, transcript and composer —
	 * every time a background refresh flipped `status` between `loading` and
	 * `ready`, which looked like the chrome reloading under the reader.
	 */
	const threads = useAgentStore((state) => state.threads);
	const catalog = useAgentStore((state) => state.catalog);
	const status = useAgentStore((state) => state.status);
	const error = useAgentStore((state) => state.error);
	const nextCursor = useAgentStore((state) => state.nextCursor);
	const loadingMore = useAgentStore((state) => state.loadingMore);
	const loadMoreError = useAgentStore((state) => state.loadMoreError);
	const threadQuery = useAgentStore((state) => state.query);
	const load = useAgentStore((state) => state.load);
	const loadMore = useAgentStore((state) => state.loadMore);
	const searchThreads = useAgentStore((state) => state.search);
	const rename = useAgentStore((state) => state.rename);
	const remove = useAgentStore((state) => state.remove);
	const removeMany = useAgentStore((state) => state.removeMany);
	const generateTitle = useAgentStore((state) => state.generateTitle);
	const settings = useAgentStore((state) => state.settings);

	const { preferences, setPreference } = useAgentPreferences();

	useEffect(() => {
		void load();
		void useAgentStore.getState().loadSettings();
	}, [load]);

	/**
	 * Restores the last open conversation exactly once, and only when the url
	 * carries no intent of its own — neither a thread nor the palette's
	 * `?new=1`. Later returns to a bare `/agent` mean "new chat", not "bounce
	 * me back".
	 */
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current) return;
		restored.current = true;
		if (selectedId || searchParams.has('new')) return;
		const remembered = readAgentLocal().thread;
		if (!remembered) return;
		setThreadParam(remembered);
	}, [selectedId, searchParams, setThreadParam]);

	// Clearing is explicit (new chat, delete): an effect that remembered the
	// void would wipe the restore target during the renders before it.
	useEffect(() => {
		if (selectedId) rememberThread(selectedId);
	}, [selectedId]);

	/**
	 * The selection of the next turn. Shared/local settings reconcile first,
	 * then the catalog corrects retired capabilities before the UI can use it.
	 */
	const [selection, setSelection] = useState<AgentSelection>();
	useEffect(() => {
		if (!catalog || settings === undefined || selection) return;
		const restored = restoreSelection(catalog, settings.selection);
		setSelection(restored);
		const remembered = settings.selection;
		if (
			remembered &&
			(remembered.model !== restored.model ||
				remembered.reasoning !== restored.reasoning ||
				remembered.maxSteps !== restored.maxSteps ||
				remembered.temperature !== restored.temperature ||
				remembered.tools.length !== restored.tools.length ||
				remembered.tools.some((tool, index) => tool !== restored.tools[index]))
		) {
			void useAgentStore
				.getState()
				.saveSettings({ selection: restored })
				.then((failure) => {
					if (failure) toast.error(failure);
				});
		}
	}, [catalog, selection, settings]);

	const changeSelection = useCallback((next: AgentSelection) => {
		setSelection(next);
		void useAgentStore
			.getState()
			.saveSettings({ selection: next })
			.then((failure) => {
				if (failure) toast.error(failure);
			});
	}, []);

	const [session, setSession] = useState<ChatSession>();
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const [sessionError, setSessionError] = useState<string>();
	const [retryToken, setRetryToken] = useState(0);
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;
	const sessionGeneration = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies(retryToken): the retry button bumps it to re-run this load; it is the effect's trigger, not an input.
	useEffect(() => {
		// A draft's promotion keeps the chatId, so this effect has nothing to do.
		if (selectedId && sessionRef.current?.chatId === selectedId) return;

		if (!selectedId) {
			if (sessionRef.current?.isDraft) return;
			setSessionError(undefined);
			setSession({
				chatId: crypto.randomUUID(),
				initialMessages: [],
				window: EMPTY_WINDOW,
				isDraft: true,
				generation: ++sessionGeneration.current,
			});
			return;
		}

		/**
		 * A conversation still answering keeps its runtime in the registry, so
		 * coming back to it reattaches instead of reading a page the stream has
		 * already moved past.
		 */
		const running = liveRun(selectedId);
		if (running) {
			setSessionError(undefined);
			setSession({
				chatId: selectedId,
				initialMessages: running.chat.messages,
				window: running.window,
				isDraft: false,
				generation: ++sessionGeneration.current,
			});
			return;
		}

		let stale = false;
		setSession(undefined);
		setSessionError(undefined);
		// The newest page, not the whole thread: a conversation of a thousand
		// turns opens in one bounded read and walks back on demand.
		void readThreadMessages(selectedId)
			.then((page) => {
				if (stale) return;
				setSession({
					chatId: selectedId,
					initialMessages: page.messages,
					window: {
						oldest: page.oldest,
						newest: page.newest,
						hasOlder: page.hasOlder,
						hasNewer: page.hasNewer,
					},
					isDraft: false,
					generation: ++sessionGeneration.current,
				});
			})
			.catch((failure: unknown) => {
				if (stale) return;
				if (
					failure instanceof AgentApiError &&
					!isTransientApiFailure(failure.status)
				) {
					// The thread no longer exists. Leaving the url is the honest
					// answer; a connection hiccup must never read as a deletion.
					rememberThread(undefined);
					setThreadParam(undefined);
					return;
				}
				setSessionError(
					navigator.onLine
						? 'This conversation could not be loaded. Try again in a moment.'
						: 'No connection. Opening a conversation needs to reach the server.',
				);
			});
		return () => {
			stale = true;
		};
	}, [selectedId, setThreadParam, retryToken]);

	/** A draft's first send: create the row, then promote in place. */
	const ensureThread = useCallback(
		async (firstText: string): Promise<AgentEnsureThreadResult> => {
			const current = sessionRef.current;
			if (!current) return cancelledSend();
			if (!current.isDraft) return { status: 'ready' };
			const expectedId = current.chatId;
			const expectedGeneration = current.generation;
			try {
				const created = await createThread(expectedId);
				// Optimistic title so the rail and breadcrumb read right away; the
				// turn's onFinish reconciles it with what the server derived.
				useAgentStore.getState().upsertLocal({
					...created,
					title: draftThreadTitle(firstText),
				});
			} catch {
				return {
					status: 'failed',
					message: navigator.onLine
						? 'This conversation could not be created. Try again in a moment.'
						: 'No connection. Starting a conversation needs to reach the server.',
				};
			}
			setSession((value) =>
				value?.chatId === expectedId && value.generation === expectedGeneration
					? { ...value, isDraft: false }
					: value,
			);
			/**
			 * Only if this draft is still what the screen is on. Leaving it — for
			 * another conversation, or for a fresh one — no longer cancels the
			 * send: the row exists, the run keeps streaming into it, and the rail
			 * shows it answering. Yanking the url back would undo the navigation
			 * that made that possible.
			 */
			const active = sessionRef.current;
			if (
				selectedIdRef.current === undefined &&
				active?.chatId === expectedId &&
				active.generation === expectedGeneration
			) {
				rememberThread(expectedId);
				setThreadParam(expectedId);
			}
			return { status: 'ready' };
		},
		[setThreadParam],
	);

	/**
	 * Every transient command the route hands the transcript, in one object.
	 *
	 * All of them belong to the conversation that produced them, so changing
	 * thread clears the whole object instead of a growing checklist of setters:
	 * a command added later cannot forget to reset. Forgetting is what made a
	 * single Ctrl+Shift+ArrowUp reopen every later thread at its oldest page,
	 * and a compacted thread grow a second marker after a round trip away.
	 */
	const [threadCommands, setThreadCommands] = useState<{
		/** A finder match to open the transcript at. */
		jump?: { messageId: string; position: number };
		/**
		 * A token per press rather than a boolean: going to an end of the thread
		 * twice in a row has to be two commands, not one state that did not change.
		 */
		edge?: { edge: 'start' | 'end'; token: number };
		/** The marker a compaction just wrote, to append in place. */
		compaction?: AgentUIMessage;
	}>({});

	/**
	 * Manual context compaction. Deliberately never automatic: running out of
	 * a model's window surfaces as that turn's provider error, and choosing
	 * between compacting and switching models is a decision, not a fallback.
	 */
	const [compacting, setCompacting] = useState(false);
	const compactingRef = useRef(false);
	/**
	 * Which conversations are answering right now — several may be. Nothing
	 * here blocks navigation any more: the only operations a running turn still
	 * rules out are the ones that would race its own thread's mutation lease.
	 */
	const running = useSyncExternalStore(
		subscribeRuns,
		runningThreads,
		() => emptyRunning,
	);
	const chatBusy = selectedId !== undefined && running.includes(selectedId);

	/**
	 * A conversation answering off screen has to say when it is done, or the
	 * only way to find out is to go looking. Deleted threads are skipped: their
	 * run ends the same way a finished one does.
	 */
	const wasRunning = useRef<readonly string[]>(emptyRunning);
	useEffect(() => {
		const before = wasRunning.current;
		wasRunning.current = running;
		for (const id of before) {
			if (running.includes(id) || id === selectedIdRef.current) continue;
			const thread = useAgentStore
				.getState()
				.threads.find((entry) => entry.id === id);
			if (!thread) continue;
			toast.success(`“${thread.title}” finished answering.`, {
				action: { label: 'Open', onClick: () => setThreadParam(id) },
			});
		}
	}, [running, setThreadParam]);
	const [generatingTitleId, setGeneratingTitleId] = useState<string>();
	const generateTitleFor = useCallback(
		async (thread: AgentThread) => {
			if (!selection?.model || generatingTitleId || isThreadRunning(thread.id))
				return;
			setGeneratingTitleId(thread.id);
			const failure = await generateTitle(thread.id, selection.model);
			setGeneratingTitleId(undefined);
			if (failure) toast.error(failure);
		},
		[generateTitle, generatingTitleId, selection?.model],
	);
	const compactionFallback = selection?.model;
	const compact = useCallback(async () => {
		// No selection yet means the catalog is still loading; nothing to compact with.
		if (
			!selectedId ||
			!compactionFallback ||
			isThreadRunning(selectedId) ||
			compactingRef.current
		)
			return;
		const threadId = selectedId;
		compactingRef.current = true;
		setCompacting(true);
		try {
			// The composer's model rides along as the fallback for when no
			// compaction model was ever configured in the settings popover.
			const message = await compactThread(threadId, compactionFallback);
			if (selectedIdRef.current !== threadId) return;
			setThreadCommands((current) => ({ ...current, compaction: message }));
			void useAgentStore.getState().load(true);
			toast.success('Context compacted. The model reads from the summary on.');
		} catch {
			toast.error(
				navigator.onLine
					? 'Compaction failed. The thread is unchanged.'
					: 'No connection. Compacting needs to reach the server.',
			);
		} finally {
			compactingRef.current = false;
			setCompacting(false);
		}
	}, [selectedId, compactionFallback]);

	const changeSettings = useCallback((next: Partial<AgentSettings>) => {
		void useAgentStore
			.getState()
			.saveSettings(next)
			.then((failure) => {
				if (failure) toast.error(failure);
			});
	}, []);

	/**
	 * The in-thread finder. The search lives here because the thread id does;
	 * the transcript only receives the chosen match as a command to open
	 * itself at that turn.
	 */
	const [matches, setMatches] = useState<AgentSearchMatch[]>([]);
	const [searching, setSearching] = useState(false);
	const [loadingSearchMore, setLoadingSearchMore] = useState(false);
	const [searchCursor, setSearchCursor] = useState<number | null>(null);
	const [searchError, setSearchError] = useState<string>();
	const searchGeneration = useRef(0);
	const activeSearchQuery = useRef('');
	const [finderOpen, setFinderOpen] = useState(false);

	const runSearch = useCallback(
		async (query: string) => {
			const generation = ++searchGeneration.current;
			activeSearchQuery.current = query.trim();
			setLoadingSearchMore(false);
			if (!selectedId || query.trim().length === 0) {
				setMatches([]);
				setSearchCursor(null);
				setSearchError(undefined);
				return;
			}
			setSearching(true);
			setSearchError(undefined);
			try {
				const page = await searchThread(selectedId, query.trim());
				if (
					generation !== searchGeneration.current ||
					selectedIdRef.current !== selectedId
				)
					return;
				setMatches(page.matches);
				setSearchCursor(page.nextCursor);
			} catch {
				if (generation !== searchGeneration.current) return;
				setMatches([]);
				setSearchCursor(null);
				setSearchError(
					navigator.onLine
						? 'The search could not reach the server.'
						: 'No connection. Searching needs to reach the server.',
				);
			} finally {
				if (generation === searchGeneration.current) setSearching(false);
			}
		},
		[selectedId],
	);

	const loadMoreSearch = useCallback(async () => {
		const threadId = selectedIdRef.current;
		const query = activeSearchQuery.current;
		const cursor = searchCursor;
		if (!threadId || !query || cursor === null || loadingSearchMore) return;
		const generation = searchGeneration.current;
		setLoadingSearchMore(true);
		setSearchError(undefined);
		try {
			const page = await searchThread(threadId, query, { before: cursor });
			if (
				generation !== searchGeneration.current ||
				selectedIdRef.current !== threadId
			)
				return;
			setMatches((current) => {
				const known = new Set(current.map((match) => match.id));
				return [
					...current,
					...page.matches.filter((match) => !known.has(match.id)),
				];
			});
			setSearchCursor(page.nextCursor);
		} catch {
			if (generation !== searchGeneration.current) return;
			setSearchError(
				navigator.onLine
					? 'More matches could not be loaded.'
					: 'No connection. Loading more matches needs the server.',
			);
		} finally {
			if (generation === searchGeneration.current) setLoadingSearchMore(false);
		}
	}, [loadingSearchMore, searchCursor]);

	// Leaving a conversation drops its results and its pending commands; both
	// belong to that thread.
	// biome-ignore lint/correctness/useExhaustiveDependencies(selectedId): the thread changing is the whole trigger; the effect reads nothing it could list instead.
	useEffect(() => {
		searchGeneration.current += 1;
		activeSearchQuery.current = '';
		setLoadingSearchMore(false);
		setMatches([]);
		setSearchCursor(null);
		setSearchError(undefined);
		setThreadCommands({});
	}, [selectedId]);

	const selectThread = useCallback(
		(id: string) => {
			setThreadParam(id);
		},
		[setThreadParam],
	);

	/**
	 * Branch the open conversation at one of its replies. The fork is a new
	 * thread, so landing in it goes through the same selection path a rail
	 * click uses; the store row appears optimistically and `load` reconciles.
	 */
	const forkThreadAt = useCallback(
		async (messageId: string) => {
			if (!selectedId) return;
			try {
				const forked = await forkThread(selectedId, messageId);
				useAgentStore.getState().upsertLocal(forked);
				selectThread(forked.id);
				toast.success('Forked — you are now in the copy.');
			} catch {
				toast.error(
					navigator.onLine
						? 'Forking could not reach the server.'
						: 'No connection. Forking needs to reach the server.',
				);
			}
		},
		[selectedId, selectThread],
	);

	const startNewChat = useCallback(() => {
		setSelectedThreads(new Set());
		rememberThread(undefined);
		setThreadParam(undefined);
	}, [setThreadParam]);

	// "New chat" from the palette arrives as `?new=1`.
	useConsumeCreateParam(startNewChat);

	/**
	 * Two open states, never one. This screen follows its own `lg` rail
	 * breakpoint so the 768–1023 px range gets the sheet rather than neither
	 * navigation surface. The overlay only ever opens by explicit action.
	 */
	const railIsDesktop = useSyncExternalStore(
		subscribeToAgentRail,
		agentRailIsDesktop,
		agentRailServerSnapshot,
	);
	const [railOpen, setRailOpen] = useState(true);
	const [drawerOpen, setDrawerOpen] = useState(false);
	useEffect(() => {
		if (railIsDesktop) setDrawerOpen(false);
	}, [railIsDesktop]);

	const [renaming, setRenaming] = useState<AgentThread>();
	const [deleting, setDeleting] = useState<AgentThread>();
	const [dialogBusy, setDialogBusy] = useState(false);
	const [dialogError, setDialogError] = useState<string>();
	const [selectedThreads, setSelectedThreads] = useState<Set<string>>(
		new Set(),
	);
	const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
	const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
	const [bulkDeleteError, setBulkDeleteError] = useState<string>();
	useEffect(() => {
		void selectedId;
		setSelectedThreads(new Set());
		setBulkDeleteOpen(false);
		setBulkDeleteError(undefined);
	}, [selectedId]);

	const dialogOpen =
		renaming !== undefined || deleting !== undefined || bulkDeleteOpen;

	const toggleThreadList = useCallback(() => {
		if (!railIsDesktop) setDrawerOpen((open) => !open);
		else setRailOpen((open) => !open);
	}, [railIsDesktop]);

	// The bare letter starts a chat; Ctrl+Alt+B folds this screen's own rail,
	// the same combination Calendar and Notes use for their panels. Both are
	// skipped while a dialog is open, where focus often rests on a button the
	// editable check would not cover.
	useEffect(() => {
		if (dialogOpen) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (isAgentRailShortcut(event)) {
				event.preventDefault();
				toggleThreadList();
				return;
			}
			// The transcript shortcuts only mean something with a thread open.
			if (selectedId) {
				if (isThreadFindShortcut(event)) {
					event.preventDefault();
					setFinderOpen(true);
					return;
				}
				// Shift first: the plain predicates require it to be up, so the
				// order is belt-and-braces rather than load-bearing.
				if (isThreadStartShortcut(event) || isThreadEndShortcut(event)) {
					event.preventDefault();
					const edge = isThreadStartShortcut(event) ? 'start' : 'end';
					setThreadCommands((current) => ({
						...current,
						edge: { edge, token: (current.edge?.token ?? 0) + 1 },
					}));
					return;
				}
				if (isPreviousUserMessageShortcut(event)) {
					event.preventDefault();
					jumpToUserMessage('previous');
					return;
				}
				if (isNextUserMessageShortcut(event)) {
					event.preventDefault();
					jumpToUserMessage('next');
					return;
				}
			}
			if (!isNewChatShortcut(event)) return;
			event.preventDefault();
			startNewChat();
		}

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [dialogOpen, selectedId, startNewChat, toggleThreadList]);

	async function confirmRename(title: string) {
		if (!renaming) return;
		setDialogBusy(true);
		const failure = await rename(renaming.id, title);
		setDialogBusy(false);

		if (failure) {
			setDialogError(failure);
			return;
		}
		setRenaming(undefined);
	}

	async function confirmDelete() {
		if (!deleting) return;
		// Nothing may keep streaming into a thread that is about to stop
		// existing; its row disables this while it answers, but a turn can
		// start between opening the menu and confirming.
		dropRun(deleting.id);
		setDialogBusy(true);
		const failure = await remove(deleting.id);
		setDialogBusy(false);

		if (failure) {
			setDialogError(failure);
			return;
		}
		if (deleting.id === selectedId) startNewChat();
		setDeleting(undefined);
	}

	async function confirmBulkDelete() {
		if (selectedThreads.size === 0 || bulkDeleteBusy) return;
		const ids = [...selectedThreads];
		for (const id of ids) dropRun(id);
		setBulkDeleteBusy(true);
		setBulkDeleteError(undefined);
		const result = await removeMany(ids);
		setBulkDeleteBusy(false);
		if (result.error) {
			setBulkDeleteError(result.error);
			return;
		}
		const deleted = new Set(result.deleted);
		setSelectedThreads(
			(current) => new Set([...current].filter((id) => !deleted.has(id))),
		);
		setBulkDeleteOpen(false);
		if (selectedId && deleted.has(selectedId)) startNewChat();
	}

	if (!catalog || !selection) {
		return (
			<section
				aria-label="Agent"
				className="flex min-h-[calc(100dvh-4rem)] w-full flex-col items-center justify-center gap-3 p-6 text-center"
			>
				{status === 'failed' || status === 'offline' ? (
					<>
						<p className="font-medium">{error}</p>
						<Button variant="outline" onClick={() => void load(true)}>
							Try again
						</Button>
					</>
				) : (
					<div className="flex items-center gap-3 text-muted-foreground text-sm">
						<Spinner /> Loading the agent…
					</div>
				)}
			</section>
		);
	}

	const rail = (inSheet: boolean) => (
		<AgentThreadRail
			threads={threads}
			loading={status === 'loading'}
			loadingMore={loadingMore}
			loadMoreError={loadMoreError}
			hasMore={nextCursor !== null}
			error={error}
			query={threadQuery}
			selectedId={selectedId}
			selected={selectedThreads}
			generatingTitleId={generatingTitleId}
			running={running}
			reserveCloseSpace={inSheet}
			onLoadMore={() => void loadMore()}
			onQueryChange={(next) => {
				setSelectedThreads(new Set());
				setBulkDeleteOpen(false);
				setBulkDeleteError(undefined);
				void searchThreads(next);
			}}
			onSelect={(id) => {
				setSelectedThreads(new Set());
				selectThread(id);
				setDrawerOpen(false);
			}}
			onNew={() => {
				startNewChat();
				setDrawerOpen(false);
			}}
			onRetry={() => void load(true)}
			onRename={(thread) => {
				setDialogError(undefined);
				setRenaming(thread);
			}}
			onDelete={(thread) => {
				setDialogError(undefined);
				setDeleting(thread);
			}}
			onGenerateTitle={(thread) => void generateTitleFor(thread)}
			onSelectionChange={setSelectedThreads}
			onSelectionLimit={() =>
				toast.error(
					`You can select up to ${MAX_BULK_SELECTION} conversations at once.`,
				)
			}
			onDeleteSelected={() => {
				setBulkDeleteError(undefined);
				setBulkDeleteOpen(true);
			}}
			{...(inSheet ? {} : { onCollapse: () => setRailOpen(false) })}
		/>
	);

	return (
		<section aria-label="Agent" className="flex w-full flex-1">
			{/*
			 * Navigation chrome, like the shell's own sidebar: it scrolls
			 * internally while the document stays the page's only scroller.
			 * Folded away by width so the transcript widens into the space.
			 */}
			<aside
				className={`sticky top-16 hidden h-[calc(100dvh-4rem)] shrink-0 overflow-hidden border-r transition-[width] duration-100 ease-linear motion-reduce:transition-none lg:block ${
					railOpen ? 'w-72' : 'w-0 border-transparent'
				}`}
				inert={!railOpen}
			>
				<div className="h-full w-72">{rail(false)}</div>
			</aside>

			<div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full min-w-0 max-w-5xl flex-1 flex-col px-4 sm:px-6">
				{/*
				 * The screen's own toolbar, pinned under the shell header. On a
				 * phone it carries the actions the missing rail would have — open
				 * the list, start a chat — instead of a bar whose only job was to
				 * say "Conversations".
				 */}
				<div className="-mx-4 sticky top-16 z-20 flex h-12 items-center gap-1 bg-background px-2 sm:-mx-6 sm:px-4">
					<Button
						variant="ghost"
						size="icon"
						className={`max-sm:size-11 ${railOpen ? 'lg:hidden' : ''}`}
						onClick={toggleThreadList}
						aria-label="Conversations"
						aria-keyshortcuts="Control+Alt+B"
					>
						<MessagesSquareIcon aria-hidden="true" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="max-sm:size-11 lg:hidden"
						onClick={startNewChat}
						aria-label="New chat"
						aria-keyshortcuts="n"
					>
						<PlusIcon aria-hidden="true" />
					</Button>

					<div className="flex-1" />

					{/*
					 * Walking a long thread by its own questions. Here rather than
					 * floating over the transcript: on a phone the floating pair
					 * covered the stats row of the last message.
					 */}
					<Button
						variant="ghost"
						size="icon"
						className="max-sm:size-11"
						onClick={() => jumpToUserMessage('previous')}
						aria-label="Previous question"
						aria-keyshortcuts="Control+ArrowUp"
					>
						<ArrowUpIcon aria-hidden="true" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="max-sm:size-11"
						onClick={() => jumpToUserMessage('next')}
						aria-label="Next question"
						aria-keyshortcuts="Control+ArrowDown"
					>
						<ArrowDownIcon aria-hidden="true" />
					</Button>

					{selectedId && (
						<AgentThreadFinder
							matches={matches}
							searching={searching}
							loadingMore={loadingSearchMore}
							hasMore={searchCursor !== null}
							error={searchError}
							open={finderOpen}
							onOpenChange={setFinderOpen}
							onSearch={(query) => void runSearch(query)}
							onLoadMore={() => void loadMoreSearch()}
							onJump={(match) =>
								setThreadCommands((current) => ({
									...current,
									jump: { messageId: match.id, position: match.position },
								}))
							}
						/>
					)}

					{selectedId && (
						<Button
							variant="ghost"
							size="icon"
							className="max-sm:size-11"
							onClick={() => void compact()}
							disabled={compacting || chatBusy}
							aria-label="Compact context"
							title="Summarize the thread so the model reads from the summary on"
						>
							{compacting ? (
								<Spinner className="size-4" />
							) : (
								<FoldVerticalIcon aria-hidden="true" />
							)}
						</Button>
					)}

					<AgentPreferencesControl
						preferences={preferences}
						setPreference={setPreference}
						models={catalog?.models ?? []}
						settings={settings}
						onSettingsChange={changeSettings}
					/>
				</div>

				{sessionError ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
						<p className="font-medium">{sessionError}</p>
						<Button
							variant="outline"
							onClick={() => setRetryToken((token) => token + 1)}
						>
							Try again
						</Button>
					</div>
				) : session ? (
					<AgentChat
						key={session.chatId}
						chatId={session.chatId}
						initialMessages={session.initialMessages}
						initialWindow={session.window}
						jumpTarget={threadCommands.jump}
						edgeRequest={threadCommands.edge}
						compactionMessage={threadCommands.compaction}
						onFork={(messageId) => void forkThreadAt(messageId)}
						catalog={catalog}
						selection={selection}
						preferences={preferences}
						onSelectionChange={changeSelection}
						ensureThread={ensureThread}
						/*
						 * The compaction holds this thread's mutation lease, so every
						 * send would come back a 409 while it runs. Blocking is not
						 * enough on its own: the chat says this sentence where the
						 * person is about to type.
						 */
						busyReason={
							compacting
								? 'Compacting the context — sending resumes when it finishes.'
								: undefined
						}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
						<Spinner /> Opening the conversation…
					</div>
				)}
			</div>

			{!railIsDesktop && (
				<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
					<SheetContent side="left" className="w-80 p-0">
						<SheetHeader className="sr-only">
							<SheetTitle>Conversations</SheetTitle>
							<SheetDescription>
								Pick a conversation or start a new one.
							</SheetDescription>
						</SheetHeader>
						{rail(true)}
					</SheetContent>
				</Sheet>
			)}

			<ThreadRenameDialog
				target={renaming}
				busy={dialogBusy}
				error={dialogError}
				onConfirm={(title) => void confirmRename(title)}
				onClose={() => setRenaming(undefined)}
			/>

			<ThreadBulkDeleteDialog
				count={selectedThreads.size}
				open={bulkDeleteOpen}
				busy={bulkDeleteBusy}
				error={bulkDeleteError}
				onConfirm={() => void confirmBulkDelete()}
				onClose={() => setBulkDeleteOpen(false)}
			/>

			<ThreadDeleteDialog
				target={deleting}
				busy={dialogBusy}
				error={dialogError}
				onConfirm={() => void confirmDelete()}
				onClose={() => setDeleting(undefined)}
			/>
		</section>
	);
}
