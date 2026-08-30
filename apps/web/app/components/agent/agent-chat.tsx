import { useChat } from '@ai-sdk/react';
import { AgentComposer } from '@web/components/agent/agent-composer';
import {
	AgentMessageActions,
	type AgentMessageStats,
} from '@web/components/agent/agent-message-actions';
import { AgentMessageParts } from '@web/components/agent/agent-message-parts';
import { Message } from '@web/components/agent/elements/message';
import { Shimmer } from '@web/components/agent/elements/shimmer';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import {
	type AgentSelection,
	HEADER_OFFSET,
	isPinnedToBottom,
	messagesReferenceFiles,
	messageText,
	scrollWindowTo,
	turnFailureMessage,
	USER_ANCHOR_ATTR,
} from '@web/lib/agent';
import {
	type AgentCatalog,
	type AgentMessagePage,
	type AgentUIMessage,
	readThreadMessages,
} from '@web/lib/agent-api';
import type { AgentPreferences } from '@web/lib/agent-preferences';
import {
	acquireRun,
	markRunBusy,
	releaseRun,
	retainRun,
	setRunWindow,
} from '@web/lib/agent-runs';
import { useStorageStore } from '@web/lib/storage-store';
import { cn } from '@web/lib/utils';
import {
	ArrowDownIcon,
	BotIcon,
	ChevronDownIcon,
	FoldVerticalIcon,
} from 'lucide-react';
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

/** How many older messages one step into the past brings back. */
const PAGE_SIZE = 30;

/** How long a jumped-to message stays marked before fading back in. */
const HIGHLIGHT_MS = 2200;

export type AgentEnsureThreadResult =
	| { status: 'ready' }
	| { status: 'failed' | 'cancelled'; message: string };

/**
 * One turn, memoized on its own message.
 *
 * A stream re-renders the conversation on every chunk, but only the last
 * message actually changed: `useChat` keeps the identity of the earlier ones.
 * Without this, a long thread re-rendered — and re-parsed every markdown
 * block of — the whole transcript dozens of times per second.
 */
const MessageRow = memo(function MessageRow({
	message,
	isStreaming,
	highlighted,
	busy,
	modelLabels,
	onEdit,
	onResend,
	onFork,
}: {
	message: AgentUIMessage;
	isStreaming: boolean;
	/** Finder jump target, or the message a rewrite is about to replace. */
	highlighted: boolean;
	/** A turn is in flight somewhere: rewriting history now would race it. */
	busy: boolean;
	modelLabels: Record<string, string>;
	/** Loads this turn's words into the composer; sending replaces the tail. */
	onEdit: (message: AgentUIMessage) => void;
	/** Send `text` as this user message again; everything after it falls. */
	onResend: (message: AgentUIMessage, text: string) => void;
	onFork: (message: AgentUIMessage) => void;
}) {
	const stats = message.metadata as AgentMessageStats | undefined;
	const isUser = message.role === 'user';

	if (stats?.kind === 'compaction')
		return (
			<CompactionRow
				message={message}
				modelLabel={stats.model ? modelLabels[stats.model] : undefined}
			/>
		);

	return (
		<div
			data-message-id={message.id}
			className={cn(
				'flex scroll-mt-28 flex-col gap-1.5 rounded-lg transition-colors duration-300 motion-reduce:transition-none',
				highlighted && 'bg-muted/60 ring-1 ring-ring/40',
			)}
			{...(isUser ? { [USER_ANCHOR_ATTR]: '' } : {})}
		>
			<Message role={message.role}>
				<AgentMessageParts message={message} isStreaming={isStreaming} />
			</Message>
			{/* While a turn streams its numbers are not final, so the row waits. */}
			{!isStreaming && (
				<AgentMessageActions
					text={messageText(message.parts)}
					stats={isUser ? undefined : stats}
					modelLabel={stats?.model ? modelLabels[stats.model] : undefined}
					align={isUser ? 'end' : 'start'}
					{...(isUser && !busy
						? {
								onEdit: () => onEdit(message),
								onRetry: () => onResend(message, messageText(message.parts)),
							}
						: {})}
					{...(!isUser && !busy ? { onFork: () => onFork(message) } : {})}
				/>
			)}
		</div>
	);
});

/**
 * A compaction marker: a divider the reader can open, not a reply. The turns
 * above it are still on screen and in Postgres — what changed is that the
 * model now reads from here on — so the styling has to say "milestone",
 * not "the agent said this".
 */
function CompactionRow({
	message,
	modelLabel,
}: {
	message: AgentUIMessage;
	modelLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div
			data-message-id={message.id}
			className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-3 text-sm"
		>
			<button
				type="button"
				className="flex items-center gap-2 text-left font-medium text-muted-foreground"
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
			>
				<FoldVerticalIcon aria-hidden="true" className="size-4 shrink-0" />
				<span className="flex-1">
					Context compacted{modelLabel ? ` by ${modelLabel}` : ''} — the model
					reads from here on
				</span>
				<ChevronDownIcon
					aria-hidden="true"
					className={cn(
						'size-4 shrink-0 transition-transform',
						open && 'rotate-180',
					)}
				/>
			</button>
			{open && <AgentMessageParts message={message} isStreaming={false} />}
		</div>
	);
}

/**
 * One conversation. The parent keys this component by `chatId`, so opening
 * another thread remounts it clean; a draft's promotion to a real thread
 * keeps the id — and therefore the stream — alive.
 */
export function AgentChat({
	chatId,
	initialMessages,
	initialWindow,
	catalog,
	selection,
	preferences,
	jumpTarget,
	edgeRequest,
	compactionMessage,
	onFork,
	onSelectionChange,
	ensureThread,
	busyReason,
}: {
	chatId: string;
	initialMessages: AgentUIMessage[];
	/** Where the opened page sits in the thread, so older ones can be found. */
	initialWindow: Omit<AgentMessagePage, 'messages'>;
	catalog: AgentCatalog;
	selection: AgentSelection;
	preferences: AgentPreferences;
	/** A finder result to open the transcript at; changes are commands. */
	jumpTarget?: { messageId: string; position: number };
	/** Ctrl+Shift+Arrow: go to an end of the thread, loading it if need be. */
	edgeRequest?: { edge: 'start' | 'end'; token: number };
	/** Server-created marker to add without remounting this conversation. */
	compactionMessage?: AgentUIMessage;
	/** Branch a new thread at this reply; the route owns the navigation. */
	onFork: (messageId: string) => void;
	onSelectionChange: (next: AgentSelection) => void;
	/** Creates the thread on a draft's first send; non-ready outcomes keep the text. */
	ensureThread: (firstText: string) => Promise<AgentEnsureThreadResult>;
	/**
	 * A route-level operation holds this thread's mutation lease, so no send
	 * can succeed until it finishes. It carries the reason rather than a bare
	 * boolean because the composer going inert without saying why is its own
	 * bug — and only the route knows which operation it is.
	 */
	busyReason?: string;
}) {
	/**
	 * Read at send time through refs: changing the model between turns must
	 * shape the next request without rebuilding the chat mid-stream.
	 */
	const selectionRef = useRef(selection);
	selectionRef.current = selection;

	/**
	 * The runtime of this conversation lives in the registry, not in this
	 * component: a turn has to keep running — and keep its state — while
	 * another thread is opened, or another system visited. Mounting only
	 * attaches to it.
	 */
	// Once per mount, never per render: re-acquiring on every render would hand
	// this transcript's own local edits back the page it opened with.
	const [run] = useState(() =>
		acquireRun({
			chatId,
			messages: initialMessages,
			window: initialWindow,
			getSelection: () => selectionRef.current,
		}),
	);

	const {
		messages,
		setMessages,
		sendMessage,
		status,
		error,
		regenerate,
		stop,
	} = useChat<AgentUIMessage>({ chat: run.chat });

	/**
	 * The names behind `@f:` tokens and read cards live in the Storage index,
	 * and nothing on this screen used to ask for it: the composer loads it when
	 * the mention list opens and an upload fills it as a side effect, so a
	 * thread opened fresh rendered raw uuids with no preview until one of those
	 * happened to run. Asked for here, where the need is visible, and only when
	 * the transcript actually references a file — the `idle` guard is what
	 * keeps a background failure from spinning.
	 */
	const storageStatus = useStorageStore((state) => state.status);
	const loadStorage = useStorageStore((state) => state.load);
	useEffect(() => {
		if (storageStatus !== 'idle') return;
		if (!messagesReferenceFiles(messages)) return;
		void loadStorage();
	}, [messages, storageStatus, loadStorage]);

	useEffect(() => {
		retainRun(chatId);
		// Unmounting does not clear the run's busy flag: a send already on its
		// way has to keep the thread marked as answering while it finishes into
		// a conversation nobody is looking at. `finishTurn` is what clears it.
		return () => releaseRun(chatId);
	}, [chatId]);

	const [draft, setDraft] = useState('');
	/** For callbacks that need the draft without re-creating on each keystroke. */
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const [sendError, setSendError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const [stoppedByUser, setStoppedByUser] = useState(false);
	const turnLockRef = useRef(false);
	/**
	 * This conversation's own work, which is what the route watches to keep its
	 * mutations off a running turn. Deliberately not the same value as `busy`:
	 * echoing the route's own lease back at it would be a report about itself.
	 */
	const ownBusy =
		submitting || status === 'submitted' || status === 'streaming';
	/** Nothing can be sent, whoever holds the thread. */
	const busy = ownBusy || busyReason !== undefined;
	const beginTurn = useCallback(() => {
		if (
			busyReason !== undefined ||
			turnLockRef.current ||
			status === 'submitted' ||
			status === 'streaming'
		)
			return false;
		turnLockRef.current = true;
		setStoppedByUser(false);
		setSubmitting(true);
		// Directly, not through the effect below: `ensureThread` is awaited in
		// the same tick and the thread must already read as running.
		markRunBusy(chatId, true);
		return true;
	}, [busyReason, chatId, status]);
	const finishTurn = useCallback(() => {
		turnLockRef.current = false;
		setSubmitting(false);
		// Also directly, because a send outlives its transcript: the effect below
		// stops running the moment the reader opens another conversation, and
		// this is what a `finally` still reaches from there.
		markRunBusy(chatId, false);
	}, [chatId]);

	useEffect(() => markRunBusy(chatId, submitting), [chatId, submitting]);

	/** The window this transcript holds, walked in either direction on demand. */
	const [oldest, setOldest] = useState(initialWindow.oldest);
	const [hasOlder, setHasOlder] = useState(initialWindow.hasOlder);
	const [hasNewer, setHasNewer] = useState(initialWindow.hasNewer);
	/**
	 * Mirrored into the run so a reattach starts from the window this
	 * transcript walked to, not from the one the thread was opened at.
	 */
	useEffect(
		() =>
			setRunWindow(chatId, {
				oldest,
				newest: initialWindow.newest,
				hasOlder,
				hasNewer,
			}),
		[chatId, oldest, hasOlder, hasNewer, initialWindow.newest],
	);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [olderError, setOlderError] = useState(false);
	const [highlightId, setHighlightId] = useState<string>();
	/**
	 * The rewrite in progress. The words live in the composer's draft — the
	 * same input every other send uses, so mentions, attachments and the
	 * pickers work in a rewrite — and what is held here is only which message
	 * the send will replace, plus the draft the edit displaced so cancelling
	 * gives it back.
	 */
	const [editingState, setEditingState] = useState<{
		messageId: string;
		previousDraft: string;
	}>();

	/**
	 * Retry and edit are the same wire move: resend an already-stored user
	 * message id, with the same or new words. `sendMessage` truncates the local
	 * list after that turn and the server truncates the stored thread by id, so
	 * both sides agree that history now ends here — including anything a middle
	 * window had not even loaded, which is why `hasNewer` drops.
	 */
	const droppedNewer = useRef(false);
	const restoreDroppedTail = useCallback(() => {
		if (!droppedNewer.current) return;
		droppedNewer.current = false;
		setHasNewer(true);
	}, []);
	const resendById = useCallback(
		(messageId: string, text: string) => {
			if (!text || !beginTurn()) return false;
			// The words are on their way to the server now, so the rewrite has
			// done its job; a failure surfaces as a turn error, not as lost work.
			setEditingState(undefined);
			// Claimed, not yet true: the truncation only happens once the request
			// reaches the server. Remembered so a turn that never left can put the
			// tail back instead of leaving this window pretending to be the end.
			setHasNewer((current) => {
				droppedNewer.current = current;
				return false;
			});
			void sendMessage({ text, messageId })
				// The SDK reports transport failures through `status`, but a send
				// that rejects outright reports nothing, and dropping it here would
				// leave the window claiming to be a tail it never became.
				.catch(restoreDroppedTail)
				.finally(finishTurn);
			return true;
		},
		[beginTurn, finishTurn, restoreDroppedTail, sendMessage],
	);
	const resend = useCallback(
		(message: AgentUIMessage, text: string) => {
			resendById(message.id, text);
		},
		[resendById],
	);

	/**
	 * A turn that reached the server truncated the stored thread, so the dropped
	 * tail is genuinely gone; one that errored out changed nothing there.
	 */
	useEffect(() => {
		if (status === 'streaming') droppedNewer.current = false;
		if (status === 'error') restoreDroppedTail();
	}, [restoreDroppedTail, status]);

	const editingRef = useRef(editingState);
	editingRef.current = editingState;
	const beginEdit = useCallback((message: AgentUIMessage) => {
		// Editing another message abandons the previous rewrite on purpose: one
		// rewrite at a time, and this is the explicit act of leaving it. The
		// stashed draft is the first edit's displaced one, not the rewrite's.
		setEditingState({
			messageId: message.id,
			previousDraft: editingRef.current?.previousDraft ?? draftRef.current,
		});
		setDraft(messageText(message.parts));
	}, []);
	const cancelEdit = useCallback(() => {
		const current = editingRef.current;
		if (!current) return;
		setDraft(current.previousDraft);
		setEditingState(undefined);
	}, []);
	const forkAt = useCallback(
		(message: AgentUIMessage) => onFork(message.id),
		[onFork],
	);

	/** Replaces the window with one page, from either end of the thread. */
	const showEdge = useCallback(
		async (edge: 'start' | 'end') => {
			try {
				const page = await readThreadMessages(
					chatId,
					// `after: 0` is every position, ascending: the oldest page.
					edge === 'start'
						? { after: 0, limit: PAGE_SIZE }
						: { limit: PAGE_SIZE },
				);
				setMessages(page.messages);
				setOldest(page.oldest);
				setHasOlder(page.hasOlder);
				setHasNewer(page.hasNewer);
				// The rows for this window paint on the next frame.
				requestAnimationFrame(() => {
					window.scrollTo({
						top: edge === 'start' ? 0 : document.documentElement.scrollHeight,
						behavior: 'instant',
					});
				});
				return true;
			} catch {
				// Nothing moved; the transcript stays where the reader left it.
				return false;
			}
		},
		[chatId, setMessages],
	);

	/** Stable across renders, so a memoized row does not re-render for it. */
	const modelLabels = useMemo(
		() =>
			Object.fromEntries(
				catalog.models.map((model) => [model.id, model.label]),
			),
		[catalog.models],
	);

	const submit = useCallback(async () => {
		const text = draft.trim();
		if (!text) return;
		/**
		 * A rewrite goes out through the resend path: the same message id, so
		 * the server replaces every turn after it. The composer draft only
		 * clears once the turn actually began — a blocked send loses nothing.
		 */
		if (editingState) {
			if (resendById(editingState.messageId, text)) setDraft('');
			return;
		}
		if (!beginTurn()) return;
		setSendError(undefined);
		try {
			const result = await ensureThread(text);
			if (result.status !== 'ready') {
				// The words stay in the composer: a failed creation loses nothing.
				setSendError(result.message);
				return;
			}
			/*
			 * The reply appends to whatever window is loaded, so sending from a
			 * middle one — reached through the finder — would leave a hole between
			 * the turn and the answer. Land on the end of the thread first.
			 */
			if (hasNewer && !(await showEdge('end'))) {
				setSendError(
					navigator.onLine
						? 'The latest messages could not be loaded. Try sending again.'
						: 'No connection. The latest messages must load before sending.',
				);
				return;
			}
			setDraft('');
			await sendMessage({ text });
		} finally {
			finishTurn();
		}
	}, [
		beginTurn,
		draft,
		editingState,
		ensureThread,
		finishTurn,
		hasNewer,
		resendById,
		sendMessage,
		showEdge,
	]);

	const retryFailedTurn = useCallback(() => {
		if (!beginTurn()) return;
		void regenerate().finally(finishTurn);
	}, [beginTurn, finishTurn, regenerate]);

	const seenCompaction = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!compactionMessage || seenCompaction.current === compactionMessage.id)
			return;
		// A middle window already has an unseen tail; appending the server's new
		// tail marker here would depict a contiguous history that is not loaded.
		if (hasNewer) return;
		seenCompaction.current = compactionMessage.id;
		setMessages((current) => {
			if (current.some((message) => message.id === compactionMessage.id))
				return current;
			if (status !== 'error') return [...current, compactionMessage];
			const failedUser = current.findLastIndex(
				(message) => message.role === 'user',
			);
			return failedUser < 0
				? [...current, compactionMessage]
				: [
						...current.slice(0, failedUser),
						compactionMessage,
						...current.slice(failedUser),
					];
		});
	}, [compactionMessage, hasNewer, setMessages, status]);

	/**
	 * The document height just before older messages are prepended. Growing the
	 * page above the viewport would otherwise shove what the reader is looking
	 * at downwards; the layout effect below gives back exactly what grew.
	 */
	const heightBeforePrepend = useRef<number | undefined>(undefined);

	const loadOlder = useCallback(async () => {
		if (loadingOlder || !hasOlder || oldest === null) return;
		setOlderError(false);
		setLoadingOlder(true);
		try {
			const page = await readThreadMessages(chatId, {
				before: oldest,
				limit: PAGE_SIZE,
			});
			setOlderError(false);
			if (page.messages.length === 0) {
				setHasOlder(false);
				return;
			}
			heightBeforePrepend.current = document.documentElement.scrollHeight;
			const known = new Set(page.messages.map((message) => message.id));
			setMessages((current) => [
				...page.messages,
				...current.filter((message) => !known.has(message.id)),
			]);
			setOldest(page.oldest);
			setHasOlder(page.hasOlder);
		} catch {
			setOlderError(true);
		} finally {
			setLoadingOlder(false);
		}
	}, [chatId, hasOlder, loadingOlder, oldest, setMessages]);

	/**
	 * Opens the transcript around a finder result. The window is asked for with
	 * a few turns of slack past the match so the reader lands with context
	 * rather than with the match glued to the top edge.
	 */
	useEffect(() => {
		if (!jumpTarget) return;
		let stale = false;

		const scrollToMatch = () => {
			const node = document.querySelector(
				`[data-message-id="${CSS.escape(jumpTarget.messageId)}"]`,
			);
			if (!node) return false;
			scrollWindowTo(
				node.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET - 24,
			);
			setHighlightId(jumpTarget.messageId);
			return true;
		};

		// Already on screen: no fetch, just go there.
		if (scrollToMatch()) return;

		void (async () => {
			try {
				const page = await readThreadMessages(chatId, {
					before: jumpTarget.position + 6,
					limit: PAGE_SIZE,
				});
				if (stale) return;
				setMessages(page.messages);
				setOldest(page.oldest);
				setHasOlder(page.hasOlder);
				setHasNewer(page.hasNewer);
				// The rows for this window paint on the next frame.
				requestAnimationFrame(() => {
					if (!stale) scrollToMatch();
				});
			} catch {
				// The finder keeps its own error surface; nothing to add here.
			}
		})();

		return () => {
			stale = true;
		};
	}, [chatId, jumpTarget, setMessages]);

	/** Each press carries a fresh token, so holding the keys keeps working. */
	const edgeToken = edgeRequest?.token;
	const edge = edgeRequest?.edge;
	useEffect(() => {
		if (edgeToken === undefined || !edge) return;
		void showEdge(edge);
	}, [edge, edgeToken, showEdge]);

	useEffect(() => {
		if (!highlightId) return;
		const timeout = window.setTimeout(
			() => setHighlightId(undefined),
			HIGHLIGHT_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [highlightId]);

	/**
	 * The document is the only scroller, so "pinned" is a property of the
	 * window. The ref is what the follow effect reads; the state exists only to
	 * show and hide the buttons, and is written **only when the answer
	 * changes** — a scroll event fires per frame, and setting state on each one
	 * re-rendered the whole screen while the wheel moved.
	 */
	const pinnedRef = useRef(true);
	const [pinned, setPinned] = useState(true);
	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			const next = isPinnedToBottom(
				window.scrollY,
				window.innerHeight,
				document.documentElement.scrollHeight,
			);
			if (next === pinnedRef.current) return;
			pinnedRef.current = next;
			setPinned(next);
		};
		// Coalesced to one measurement per frame: scroll and resize both fire
		// far faster than anything here needs to answer.
		const schedule = () => {
			frame ||= window.requestAnimationFrame(measure);
		};

		measure();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		return () => {
			if (frame) window.cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
		};
	}, []);

	/**
	 * Two jobs, one effect, because both have to happen before the browser
	 * paints the new message list: give back the height that a prepended page
	 * added, or — when the reader is at the end — follow the stream down.
	 * Someone who scrolled up to reread is never dragged by either.
	 */
	useLayoutEffect(() => {
		const before = heightBeforePrepend.current;
		if (before !== undefined) {
			heightBeforePrepend.current = undefined;
			const grew = document.documentElement.scrollHeight - before;
			if (grew !== 0) window.scrollBy({ top: grew, behavior: 'instant' });
			return;
		}
		if (messages.length === 0 || !pinnedRef.current) return;
		window.scrollTo({
			top: document.documentElement.scrollHeight,
			behavior: 'instant',
		});
	}, [messages]);

	/** Older pages arrive as the top of the transcript comes into view. */
	const topSentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const sentinel = topSentinelRef.current;
		if (!sentinel || !hasOlder || olderError) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
			},
			// The document scrolls, so the viewport is the root; the margin asks
			// for the next page slightly before the reader reaches the edge.
			{ rootMargin: '400px 0px 0px 0px' },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasOlder, loadOlder, olderError]);

	function scrollToBottom() {
		scrollWindowTo(document.documentElement.scrollHeight);
	}

	const hasMessages = messages.length > 0;

	return (
		<div
			className="agent-conversation flex min-w-0 flex-1 flex-col"
			data-font-size={preferences.fontSize}
			data-margins={preferences.margins}
		>
			{hasMessages ? (
				<div className="flex flex-1 flex-col gap-6 py-6">
					{hasOlder && (
						<div
							ref={topSentinelRef}
							className="flex items-center justify-center py-2 text-muted-foreground text-sm"
						>
							{loadingOlder ? (
								<span className="flex items-center gap-2">
									<Spinner /> Loading earlier messages…
								</span>
							) : olderError ? (
								<div
									className="flex flex-wrap items-center justify-center gap-2"
									role="alert"
								>
									<span>Earlier messages could not be loaded.</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => void loadOlder()}
										aria-label="Try loading earlier messages"
									>
										Try again
									</Button>
								</div>
							) : (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => void loadOlder()}
								>
									Load earlier messages
								</Button>
							)}
						</div>
					)}

					{messages.map((message, index) => (
						<MessageRow
							key={message.id}
							message={message}
							modelLabels={modelLabels}
							highlighted={
								message.id === highlightId ||
								message.id === editingState?.messageId
							}
							busy={busy}
							onEdit={beginEdit}
							onResend={resend}
							onFork={forkAt}
							isStreaming={
								status === 'streaming' &&
								index === messages.length - 1 &&
								!(message.metadata as AgentMessageStats | undefined)
									?.interrupted
							}
						/>
					))}

					{status === 'submitted' && (
						<Shimmer className="text-sm">Thinking…</Shimmer>
					)}

					{status === 'error' && !stoppedByUser && (
						<div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
							{/*
							 * `useChat` reports the response body, so a refusal the API
							 * designed — the thread's busy lease — would otherwise land
							 * here as raw JSON reading like a crash.
							 */}
							<p>{turnFailureMessage(error)}</p>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={retryFailedTurn}
							>
								Retry
							</Button>
						</div>
					)}
				</div>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
					<span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
						<BotIcon aria-hidden="true" />
					</span>
					<h1 className="font-heading font-semibold text-2xl tracking-[-0.02em]">
						What are we working on?
					</h1>
					<p className="max-w-sm text-muted-foreground text-sm leading-6">
						Ask anything. The model, its reasoning level and the tools it may
						use travel with each message — switch them below at any time.
					</p>
				</div>
			)}

			{/*
			 * Sticky, not fixed: it takes layout height, so the last message
			 * scrolls above it with no phantom padding, and it stays inside the
			 * chat column instead of covering the rail. The document remains the
			 * only scroller.
			 */}
			<div className="-mx-4 sticky bottom-0 z-20 bg-background px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6">
				{/*
				 * Only the "back to the end" affordance floats, and only when it
				 * has something to say: the question-to-question buttons live in
				 * the toolbar, where they cannot cover the stats row of the last
				 * message — which is exactly what they did on a phone.
				 */}
				{hasMessages && !pinned && (
					<div className="-top-11 pointer-events-none absolute right-4 sm:right-6">
						<Button
							size="icon-sm"
							variant="secondary"
							className="pointer-events-auto rounded-full shadow-sm max-sm:size-9"
							onClick={scrollToBottom}
							aria-label="Scroll to bottom"
						>
							<ArrowDownIcon aria-hidden="true" />
						</Button>
					</div>
				)}
				{/*
				 * Why the composer is inert, where the person is about to type. Not
				 * the composer's `error` slot: that one is destructive red, and an
				 * operation running normally is not a failure. It disappears with
				 * the condition, so it needs no state of its own.
				 */}
				{busyReason && (
					<p
						role="status"
						className="flex items-center gap-2 px-1 pb-1 text-muted-foreground text-sm"
					>
						<Spinner aria-hidden="true" className="size-4 shrink-0" />
						<span>{busyReason}</span>
					</p>
				)}
				<AgentComposer
					value={draft}
					status={status}
					busy={busy}
					catalog={catalog}
					selection={selection}
					error={sendError}
					editing={editingState !== undefined}
					onChange={setDraft}
					onSelectionChange={onSelectionChange}
					onSubmit={() => void submit()}
					onStop={() => {
						setStoppedByUser(true);
						void stop();
					}}
					onCancelEdit={cancelEdit}
				/>
			</div>
		</div>
	);
}
