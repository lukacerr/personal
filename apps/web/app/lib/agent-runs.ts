import { Chat } from '@ai-sdk/react';
import type { AgentSelection } from '@web/lib/agent';
import type { AgentMessagePage, AgentUIMessage } from '@web/lib/agent-api';
import { useAgentStore } from '@web/lib/agent-store';
import { createAgentChatTransport } from '@web/lib/agent-transport';

export type RunWindow = Omit<AgentMessagePage, 'messages'>;

type Run = {
	chat: Chat<AgentUIMessage>;
	/** Where the transcript sits in the thread, kept so a reattach is exact. */
	window: RunWindow;
	/** How many transcripts are showing this run right now. */
	mounted: number;
	/**
	 * Work its own screen reports before the SDK flips `status` — creating the
	 * thread row, mostly. Without it a thread stops counting as running for the
	 * few hundred ms between pressing send and the request leaving.
	 */
	busy: boolean;
	getSelection: () => AgentSelection;
	unsubscribe: () => void;
};

/**
 * The chat runtime of every conversation with something in flight, keyed by
 * thread id and owned by this module rather than by a mounted component.
 *
 * That is the whole feature: `useChat` never aborts on unmount, so a turn
 * already survived leaving its screen — what did not survive was the *state*,
 * which lived in the hook and went with it. A run kept here reattaches, so a
 * second conversation can be opened, or a whole other system visited, while
 * the first one answers.
 *
 * What still ends a turn is closing the tab: reattaching to a stream from a
 * page that never issued it needs the server to be able to replay it, which
 * this deliberately does not do.
 */
const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function running(run: Run) {
	return (
		run.busy ||
		run.chat.status === 'submitted' ||
		run.chat.status === 'streaming'
	);
}

/** A run nobody is showing and nothing is feeding has nothing left to keep. */
function live(run: Run) {
	return running(run) || run.mounted > 0;
}

function notify() {
	const next = [...runs.entries()]
		.filter(([, run]) => running(run))
		.map(([id]) => id)
		.sort();
	// A stable identity while the set is unchanged: `useSyncExternalStore`
	// compares snapshots by reference and would loop on a fresh array.
	if (
		next.length === snapshot.length &&
		next.every((id, index) => id === snapshot[index])
	)
		return;
	snapshot = next;
	for (const listener of listeners) listener();
}

function discard(chatId: string, run: Run) {
	run.unsubscribe();
	runs.delete(chatId);
}

/** Drops a run that has become both idle and unwatched. */
function settle(chatId: string) {
	const run = runs.get(chatId);
	if (run && !live(run)) discard(chatId, run);
	notify();
}

/**
 * The delayed index refresh after a turn. The generated title lands seconds
 * after the stream closes — the server writes it after persisting, with its
 * own LLM round-trip — so one delayed refresh picks it up. Cheap on a miss:
 * the read carries the tag it holds, so an index that did not change answers
 * 304 with no payload. Held here rather than in the screen because a turn now
 * finishes long after its screen is gone.
 */
let titleRefresh: number | undefined;

function refreshIndexAfterTurn() {
	void useAgentStore.getState().load(true);
	window.clearTimeout(titleRefresh);
	titleRefresh = window.setTimeout(
		() => void useAgentStore.getState().load(true),
		6000,
	);
}

export function acquireRun({
	chatId,
	messages,
	window: initialWindow,
	getSelection,
}: {
	chatId: string;
	messages: AgentUIMessage[];
	window: RunWindow;
	getSelection: () => AgentSelection;
}) {
	const existing = runs.get(chatId);
	if (existing) {
		// The getter belongs to whichever transcript is on screen now; the one
		// that created the run may be long gone.
		existing.getSelection = getSelection;
		/**
		 * A thread has one runtime, adopted rather than rebuilt. An idle one
		 * takes the caller's page — it just read it, and a leftover from a
		 * render that never committed would otherwise hand back older messages
		 * — while a run still answering keeps its own: that stream is the
		 * newest state there is.
		 */
		if (!running(existing)) {
			existing.chat.messages = messages;
			existing.window = initialWindow;
		}
		return existing;
	}

	const run: Run = {
		chat: undefined as unknown as Chat<AgentUIMessage>,
		window: initialWindow,
		mounted: 0,
		busy: false,
		getSelection,
		unsubscribe: () => undefined,
	};
	run.chat = new Chat<AgentUIMessage>({
		id: chatId,
		messages,
		transport: createAgentChatTransport({
			threadId: chatId,
			getSelection: () => run.getSelection(),
		}),
		// The server persists message ids as uuids; the SDK default is not one.
		generateId: () => crypto.randomUUID(),
		onFinish: ({ message, isAbort }) => {
			if (isAbort) {
				const interrupted = {
					...message,
					metadata: { ...message.metadata, interrupted: true },
				};
				const known = run.chat.messages.some(
					(entry) => entry.id === message.id,
				);
				// The abort can arrive before the partial reply was ever added
				// locally, and dropping it there would lose the turn the server
				// has already persisted.
				run.chat.messages = known
					? run.chat.messages.map((entry) =>
							entry.id === message.id ? interrupted : entry,
						)
					: [...run.chat.messages, interrupted];
			}
			refreshIndexAfterTurn();
		},
	});
	run.unsubscribe = run.chat['~registerStatusCallback'](() => {
		// The same subscription `useChat` uses. It is what tells this module a
		// turn ended on a screen nobody is looking at.
		settle(chatId);
	});
	runs.set(chatId, run);
	return run;
}

export function retainRun(chatId: string) {
	const run = runs.get(chatId);
	if (!run) return;
	run.mounted += 1;
}

export function releaseRun(chatId: string) {
	const run = runs.get(chatId);
	if (!run) return;
	run.mounted = Math.max(0, run.mounted - 1);
	/**
	 * Deferred, because React releases before it retains: an effect
	 * double-invoked in development, or a remount of the same conversation,
	 * both pass through zero within the tick. Settling there dropped the run
	 * of a turn that had just been sent — the reply still arrived, but nothing
	 * knew the thread was answering.
	 */
	queueMicrotask(() => settle(chatId));
}

export function markRunBusy(chatId: string, busy: boolean) {
	const run = runs.get(chatId);
	if (!run || run.busy === busy) return;
	run.busy = busy;
	if (busy) notify();
	else settle(chatId);
}

export function setRunWindow(chatId: string, next: RunWindow) {
	const run = runs.get(chatId);
	if (run) run.window = next;
}

/** What a reattaching transcript starts from, when there is a run to rejoin. */
export function liveRun(chatId: string) {
	const run = runs.get(chatId);
	return run && live(run) ? run : undefined;
}

export function isThreadRunning(chatId: string) {
	const run = runs.get(chatId);
	return run !== undefined && running(run);
}

/** Ends a run for good — the thread it belonged to is gone. */
export function dropRun(chatId: string) {
	const run = runs.get(chatId);
	if (!run) return;
	void run.chat.stop();
	discard(chatId, run);
	notify();
}

/** Sign-out: nothing in flight may outlive the session that authorised it. */
export function resetRuns() {
	for (const [chatId, run] of runs) {
		void run.chat.stop();
		discard(chatId, run);
	}
	window.clearTimeout(titleRefresh);
	notify();
}

export function subscribeRuns(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Sorted thread ids with a turn in flight; stable while the set is. */
export function runningThreads() {
	return snapshot;
}
