// @vitest-environment happy-dom

import type { AgentSelection } from '@web/lib/agent';
import type { AgentUIMessage } from '@web/lib/agent-api';
import {
	acquireRun,
	dropRun,
	isThreadRunning,
	liveRun,
	markRunBusy,
	releaseRun,
	resetRuns,
	retainRun,
	runningThreads,
	subscribeRuns,
} from '@web/lib/agent-runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SDK's `Chat`, reduced to what the registry actually touches: the
 * messages, the status, the subscription it settles runs from, and `stop`.
 */
const instances = vi.hoisted(() => [] as FakeChat[]);
type FakeChat = {
	id: string;
	messages: unknown[];
	status: string;
	stop: ReturnType<typeof vi.fn>;
	onFinish: (result: { message: unknown; isAbort: boolean }) => void;
	notify: () => void;
};

vi.mock('@ai-sdk/react', () => ({
	Chat: class {
		id: string;
		messages: unknown[];
		status = 'ready';
		stop = vi.fn();
		onFinish: (result: { message: unknown; isAbort: boolean }) => void;
		listeners = new Set<() => void>();
		constructor({
			id,
			messages,
			onFinish,
		}: {
			id: string;
			messages: unknown[];
			onFinish: (result: { message: unknown; isAbort: boolean }) => void;
		}) {
			this.id = id;
			this.messages = messages;
			this.onFinish = onFinish;
			instances.push(this as unknown as FakeChat);
		}
		'~registerStatusCallback' = (listener: () => void) => {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		};
		notify() {
			for (const listener of [...this.listeners]) listener();
		}
	},
}));

vi.mock('@web/lib/agent-transport', () => ({
	createAgentChatTransport: () => ({}),
}));

const storeLoad = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/agent-store', () => ({
	useAgentStore: { getState: () => ({ load: storeLoad }) },
}));

const selection: AgentSelection = {
	model: 'test-model',
	reasoning: 'off',
	tools: [],
	maxSteps: 5,
};

const EMPTY_WINDOW = {
	oldest: null,
	newest: null,
	hasOlder: false,
	hasNewer: false,
};

function open(
	chatId: string,
	messages: AgentUIMessage[] = [],
	getSelection = () => selection,
) {
	const run = acquireRun({
		chatId,
		messages,
		window: EMPTY_WINDOW,
		getSelection,
	});
	retainRun(chatId);
	return run;
}

/** What a stream starting and ending looks like from outside the SDK. */
function setStatus(chat: FakeChat, status: string) {
	chat.status = status;
	chat.notify();
}

beforeEach(() => {
	instances.length = 0;
	storeLoad.mockReset();
});

afterEach(() => resetRuns());

describe('agent runs', () => {
	/**
	 * The whole point: `useChat` never aborted on unmount, but its state went
	 * with the component. A run kept here is what lets a second conversation be
	 * opened while the first one answers.
	 */
	it('keeps a streaming conversation after its transcript unmounts', () => {
		const run = open('thread-a');
		setStatus(run.chat as unknown as FakeChat, 'streaming');
		releaseRun('thread-a');

		expect(isThreadRunning('thread-a')).toBe(true);
		expect(runningThreads()).toEqual(['thread-a']);
		expect(liveRun('thread-a')?.chat).toBe(run.chat);

		// Reopening it later attaches to the same runtime, not to a new one.
		const again = open('thread-a', []);
		expect(again.chat).toBe(run.chat);
		expect(instances).toHaveLength(1);
	});

	it('drops a run once it is neither answering nor on screen', () => {
		const run = open('thread-a');
		const chat = run.chat as unknown as FakeChat;
		setStatus(chat, 'streaming');
		releaseRun('thread-a');
		setStatus(chat, 'ready');

		expect(liveRun('thread-a')).toBeUndefined();
		expect(runningThreads()).toEqual([]);
	});

	it('keeps an idle run while its transcript is mounted', () => {
		open('thread-a');
		expect(liveRun('thread-a')).toBeDefined();
		releaseRun('thread-a');
		expect(liveRun('thread-a')).toBeUndefined();
	});

	/**
	 * One runtime per thread, adopted rather than rebuilt: an idle run takes
	 * the page the caller just read — a leftover would otherwise hand back
	 * older messages — and a streaming one keeps its own, which is newer than
	 * anything a read could return.
	 */
	it('adopts an idle run with the caller’s page and leaves a streaming one alone', () => {
		acquireRun({
			chatId: 'thread-a',
			messages: [{ id: 'stale', role: 'user', parts: [] }] as AgentUIMessage[],
			window: EMPTY_WINDOW,
			getSelection: () => selection,
		});
		const fresh = open('thread-a', [
			{ id: 'fresh', role: 'user', parts: [] },
		] as AgentUIMessage[]);

		expect(fresh.chat.messages.map((message) => message.id)).toEqual(['fresh']);
		expect(instances).toHaveLength(1);

		setStatus(fresh.chat as unknown as FakeChat, 'streaming');
		const reattached = open('thread-a', [
			{ id: 'from-a-stale-read', role: 'user', parts: [] },
		] as AgentUIMessage[]);
		expect(reattached.chat.messages.map((message) => message.id)).toEqual([
			'fresh',
		]);
	});

	/**
	 * React releases before it retains — an effect double-invoked in
	 * development, a remount of the same conversation. Settling on the way
	 * through zero dropped the run of a turn that had just been sent.
	 */
	it('survives a release immediately followed by a retain', async () => {
		const run = open('thread-a');
		releaseRun('thread-a');
		retainRun('thread-a');
		await Promise.resolve();

		expect(liveRun('thread-a')?.chat).toBe(run.chat);
	});

	/**
	 * Creating the thread row is a round trip that happens before the SDK has a
	 * status to report. Without this the thread stops counting as running for
	 * as long as that takes.
	 */
	it('counts work reported before the stream starts', () => {
		open('thread-a');
		markRunBusy('thread-a', true);
		releaseRun('thread-a');
		expect(isThreadRunning('thread-a')).toBe(true);

		markRunBusy('thread-a', false);
		expect(liveRun('thread-a')).toBeUndefined();
	});

	it('notifies subscribers when the running set changes, not on every touch', () => {
		const listener = vi.fn();
		const unsubscribe = subscribeRuns(listener);
		const run = open('thread-a');
		expect(listener).not.toHaveBeenCalled();

		setStatus(run.chat as unknown as FakeChat, 'streaming');
		expect(listener).toHaveBeenCalledTimes(1);
		setStatus(run.chat as unknown as FakeChat, 'streaming');
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it('ends a run for good when its thread is deleted', () => {
		const run = open('thread-a');
		const chat = run.chat as unknown as FakeChat;
		setStatus(chat, 'streaming');
		dropRun('thread-a');

		expect(chat.stop).toHaveBeenCalledTimes(1);
		expect(liveRun('thread-a')).toBeUndefined();
		expect(runningThreads()).toEqual([]);
	});

	/** A turn that ends while nobody is watching still reconciles the index. */
	it('refreshes the thread index when a turn finishes off screen', () => {
		const run = open('thread-a');
		const chat = run.chat as unknown as FakeChat;
		setStatus(chat, 'streaming');
		releaseRun('thread-a');

		chat.onFinish({
			message: { id: 'reply', role: 'assistant', parts: [] },
			isAbort: true,
		});
		expect(storeLoad).toHaveBeenCalledWith(true);
		expect(
			(run.chat.messages[0] as { metadata?: { interrupted?: boolean } })
				.metadata?.interrupted,
		).toBe(true);
	});
});
