// @vitest-environment happy-dom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentChat } from '@web/components/agent/agent-chat';
import { type AgentCatalog, readThreadMessages } from '@web/lib/agent-api';
import { isThreadRunning, resetRuns } from '@web/lib/agent-runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.hoisted(() => ({
	status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
	error: undefined as Error | undefined,
	sendMessage: vi.fn(),
	regenerate: vi.fn(),
	stop: vi.fn(),
	onFinish: undefined as
		| ((result: { message: unknown; isAbort: boolean }) => void)
		| undefined,
}));

type ObserverRecord = {
	fire: (isIntersecting: boolean) => void;
	disconnected: boolean;
};

let observers: ObserverRecord[] = [];

function stubIntersectionObserver() {
	observers = [];
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			private readonly record: ObserverRecord;

			constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
				this.record = {
					fire: (isIntersecting) => {
						if (!this.record.disconnected) callback([{ isIntersecting }]);
					},
					disconnected: false,
				};
				observers.push(this.record);
			}

			observe() {}
			unobserve() {}
			disconnect() {
				this.record.disconnected = true;
			}
			takeRecords() {
				return [];
			}
		},
	);
}

/**
 * The chat runtime, stubbed at the SDK rather than at our own registry: the
 * registry is what decides a turn survives its screen, so these tests run the
 * real one. `Chat` keeps the messages and the status subscription — the two
 * things `useChat` reads — and the shared double drives status and the calls.
 */
vi.mock('@ai-sdk/react', async () => {
	const { useEffect, useState } = await import('react');
	type FinishHandler = (result: { message: unknown; isAbort: boolean }) => void;
	class FakeChat {
		id: string;
		messages: unknown[];
		listeners = new Set<() => void>();
		constructor({
			id,
			messages,
			onFinish,
		}: {
			id: string;
			messages: unknown[];
			onFinish: FinishHandler;
		}) {
			this.id = id;
			this.messages = messages;
			chat.onFinish = (result) => {
				onFinish(result);
				this.notify();
			};
		}
		get status() {
			return chat.status;
		}
		get error() {
			return chat.error;
		}
		stop = (...args: unknown[]) => chat.stop(...args);
		'~registerStatusCallback' = (listener: () => void) => {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		};
		notify() {
			for (const listener of [...this.listeners]) listener();
		}
	}
	return {
		Chat: FakeChat,
		useChat: ({ chat: instance }: { chat: FakeChat }) => {
			const [, force] = useState(0);
			useEffect(() => {
				const unsubscribe = instance['~registerStatusCallback'](() =>
					force((tick) => tick + 1),
				);
				return () => {
					unsubscribe();
				};
			}, [instance]);
			return {
				messages: instance.messages,
				setMessages: (next: unknown) => {
					instance.messages =
						typeof next === 'function' ? next(instance.messages) : next;
					instance.notify();
				},
				sendMessage: chat.sendMessage,
				status: chat.status,
				error: chat.error,
				regenerate: chat.regenerate,
				stop: chat.stop,
			};
		},
	};
});

/**
 * The Storage index, which the transcript needs to put a name and a preview
 * behind a `@f:` token. Nothing else on this screen loads it.
 */
const storage = vi.hoisted(() => ({
	files: [] as unknown[],
	status: 'idle' as 'idle' | 'loading' | 'ready',
	load: vi.fn(),
}));
vi.mock('@web/lib/storage-store', () => ({
	useStorageStore: (selector: (state: typeof storage) => unknown) =>
		selector(storage),
}));
vi.mock('@web/lib/storage-api', () => ({
	storageTransport: {},
	getFileLink: vi.fn(async () => 'https://example.test/link'),
}));

/** The registry refreshes the thread index when a turn ends. */
const storeLoad = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/agent-store', () => ({
	useAgentStore: { getState: () => ({ load: storeLoad }) },
}));

vi.mock('@web/lib/agent-api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@web/lib/agent-api')>()),
	readThreadMessages: vi.fn(),
}));

vi.mock('@web/lib/agent-transport', () => ({
	createAgentChatTransport: () => ({}),
}));

const catalog: AgentCatalog = {
	models: [
		{
			id: 'test-model',
			provider: 'anthropic',
			label: 'Test model',
			attachments: { image: true, pdf: true },
			reasoning: { levels: ['off'], default: 'off' },
			temperature: null,
		},
	],
	tools: [],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function renderChatProps(
	overrides: Partial<React.ComponentProps<typeof AgentChat>> = {},
) {
	return {
		chatId: '00000000-0000-4000-8000-000000000001',
		initialMessages: [],
		initialWindow: {
			oldest: null,
			newest: null,
			hasOlder: false,
			hasNewer: false,
		},
		catalog,
		selection: {
			model: 'test-model',
			reasoning: 'off',
			tools: [],
			maxSteps: 5,
		},
		preferences: { fontSize: 'medium', margins: 'medium' } as const,
		onFork: vi.fn(),
		onSelectionChange: vi.fn(),
		ensureThread: vi.fn().mockResolvedValue({ status: 'ready' }),
		...overrides,
	};
}

function renderChat(
	overrides: Partial<React.ComponentProps<typeof AgentChat>> = {},
) {
	const props = renderChatProps(overrides);
	render(<AgentChat {...props} />);
	return props;
}

beforeEach(() => {
	stubIntersectionObserver();
	chat.status = 'ready';
	chat.error = undefined;
	chat.sendMessage.mockReset().mockResolvedValue(undefined);
	chat.regenerate.mockReset().mockResolvedValue(undefined);
	chat.stop.mockReset().mockResolvedValue(undefined);
	chat.onFinish = undefined;
	storeLoad.mockReset();
	storage.status = 'idle';
	storage.files = [];
	storage.load.mockReset();
	vi.mocked(readThreadMessages).mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
	// The registry outlives a render on purpose; each test starts from empty.
	resetRuns();
});

describe('AgentChat sending', () => {
	it('synchronously rejects a second submit while the first is creating the thread', async () => {
		const creation = deferred<{ status: 'ready' }>();
		const props = renderChat({
			ensureThread: vi.fn(() => creation.promise),
		});
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'hello');
		const form = input.closest('form');
		if (!form) throw new Error('composer form missing');

		fireEvent.submit(form);
		fireEvent.submit(form);

		expect(props.ensureThread).toHaveBeenCalledTimes(1);
		// The registry has to know before the await resolves: the thread rail and
		// every route guard read it, and creation takes a round trip.
		expect(isThreadRunning(props.chatId)).toBe(true);
		creation.resolve({ status: 'ready' });
		await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
	});

	it('keeps the draft and does not send when loading the latest window fails', async () => {
		vi.mocked(readThreadMessages).mockRejectedValueOnce(new Error('offline'));
		renderChat({
			initialWindow: {
				oldest: 10,
				newest: 20,
				hasOlder: true,
				hasNewer: true,
			},
		});
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'do not lose this');
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

		expect(
			await screen.findByText(/latest messages could not be loaded/i),
		).toBeDefined();
		expect(input).toHaveProperty('value', 'do not lose this');
		expect(chat.sendMessage).not.toHaveBeenCalled();
	});

	it('still knows the thread has a newer tail after a failed edit', async () => {
		const props = renderChatProps({
			initialMessages: [
				{
					id: 'middle-user',
					role: 'user',
					parts: [{ type: 'text', text: 'middle' }],
				},
			],
			initialWindow: {
				oldest: 10,
				newest: 10,
				hasOlder: true,
				hasNewer: true,
			},
		});
		const rendered = render(<AgentChat {...props} />);

		// Editing a stored message claims the thread now ends here — but only if
		// the request reaches the server. This one does not. The rewrite happens
		// in the one composer every send path shares.
		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
		const editor = screen.getByRole('textbox', { name: 'Message the agent' });
		expect(editor).toHaveProperty('value', 'middle');
		await userEvent.clear(editor);
		await userEvent.type(editor, 'rewritten');
		chat.sendMessage.mockRejectedValueOnce(new Error('offline'));
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

		chat.status = 'error';
		chat.error = new Error('offline');
		rendered.rerender(<AgentChat {...props} />);
		chat.status = 'ready';
		chat.error = undefined;
		rendered.rerender(<AgentChat {...props} />);

		// The stored tail was never truncated, so a later send has to walk to the
		// real end of the thread instead of appending after a hole.
		vi.mocked(readThreadMessages).mockRejectedValueOnce(new Error('offline'));
		chat.sendMessage.mockResolvedValue(undefined);
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'later turn');
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

		expect(readThreadMessages).toHaveBeenCalled();
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('keeps the draft and does not send when route preflight is cancelled', async () => {
		renderChat({
			ensureThread: vi.fn().mockResolvedValue({
				status: 'cancelled',
				message: 'Send canceled because this conversation is no longer open.',
			}),
		});
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'keep me');
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

		expect(await screen.findByText(/send canceled/i)).toBeDefined();
		expect(input).toHaveProperty('value', 'keep me');
		expect(chat.sendMessage).not.toHaveBeenCalled();
	});

	it('shows pending instead of Stop while thread creation is still in flight', async () => {
		const creation = deferred<{ status: 'ready' }>();
		renderChat({ ensureThread: vi.fn(() => creation.promise) });
		await userEvent.type(
			screen.getByRole('textbox', { name: 'Message the agent' }),
			'hello',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

		expect(
			screen.queryByRole('button', { name: 'Stop generating' }),
		).toBeNull();
		expect(
			screen.getByRole('button', { name: 'Preparing message' }),
		).toBeDefined();
		creation.resolve({ status: 'ready' });
	});

	it('locks retry synchronously and reports route busy before React updates', () => {
		const retry = deferred<void>();
		chat.sendMessage.mockReturnValueOnce(retry.promise);
		const props = renderChat({
			initialMessages: [
				{
					id: 'failed-user',
					role: 'user',
					parts: [{ type: 'text', text: 'retry me' }],
				},
			],
		});
		const button = screen.getByRole('button', {
			name: 'Retry from this message',
		});

		fireEvent.click(button);
		fireEvent.click(button);

		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(isThreadRunning(props.chatId)).toBe(true);
		retry.resolve();
	});

	it('locks failed-turn regenerate synchronously', () => {
		chat.status = 'error';
		chat.error = new Error('failed');
		const retry = deferred<void>();
		chat.regenerate.mockReturnValueOnce(retry.promise);
		const props = renderChat({
			initialMessages: [
				{
					id: 'failed-user',
					role: 'user',
					parts: [{ type: 'text', text: 'retry me' }],
				},
			],
		});
		const button = screen.getByRole('button', { name: 'Retry' });

		fireEvent.click(button);
		fireEvent.click(button);

		expect(chat.regenerate).toHaveBeenCalledTimes(1);
		expect(isThreadRunning(props.chatId)).toBe(true);
		retry.resolve();
	});

	/**
	 * A route-level operation (compaction) holds the thread's mutation lease, so
	 * the server answers a send with 409. Blocking it here is what keeps the
	 * transcript from asking for a refusal, and the reason is on screen because
	 * an inert composer with no explanation is its own bug.
	 */
	it('blocks submit, edit and retry while the route holds the thread', async () => {
		const props = renderChat({
			busyReason: 'Compacting the context — sending resumes when it finishes.',
			initialMessages: [
				{
					id: 'stored-user',
					role: 'user',
					parts: [{ type: 'text', text: 'stored question' }],
				},
			],
		});

		expect(
			screen.getByText(
				'Compacting the context — sending resumes when it finishes.',
			),
		).toBeDefined();
		expect(
			screen.getByRole('button', { name: 'Preparing message' }),
		).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
		// Rewriting history would race the same lease, so those rows go too.
		expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
		expect(
			screen.queryByRole('button', { name: 'Retry from this message' }),
		).toBeNull();

		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'hold this');
		const form = input.closest('form');
		if (!form) throw new Error('composer form missing');
		fireEvent.submit(form);

		expect(chat.sendMessage).not.toHaveBeenCalled();
		expect(input).toHaveProperty('value', 'hold this');
		// The registry is what the rail and the route guards read; a turn that
		// never began must not make the thread look like it is answering.
		expect(isThreadRunning(props.chatId)).toBe(false);
	});

	/**
	 * A rewrite started before the lease was taken lives in the composer, the
	 * one send path on screen. Swallowing that save would be the same defect as
	 * the dead menu item — and the rewrite has to still be there afterwards.
	 */
	it('keeps an open rewrite and explains why it cannot be saved yet', async () => {
		const props = renderChatProps({
			initialMessages: [
				{
					id: 'stored-user',
					role: 'user',
					parts: [{ type: 'text', text: 'original question' }],
				},
			],
		});
		const rendered = render(<AgentChat {...props} />);

		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
		const editor = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.clear(editor);
		await userEvent.type(editor, 'the rewrite worth keeping');

		rendered.rerender(
			<AgentChat
				{...props}
				busyReason="Compacting the context — sending resumes when it finishes."
			/>,
		);

		// The reason is on screen and the send affordance is inert, not gone.
		expect(
			screen.getByText(
				'Compacting the context — sending resumes when it finishes.',
			),
		).toBeDefined();
		const pending = screen.getByRole('button', { name: 'Preparing message' });
		expect(pending.hasAttribute('disabled')).toBe(true);

		fireEvent.keyDown(editor, { key: 'Enter' });
		expect(chat.sendMessage).not.toHaveBeenCalled();

		// The assertion that matters: blocked, not quietly destroyed.
		expect(editor).toHaveProperty('value', 'the rewrite worth keeping');
		expect(screen.getByText(/Editing a sent message/)).toBeDefined();
	});

	/**
	 * A jump replaces the window, so the row holding an open editor unmounts.
	 * The rewrite is not part of that window — it is work in progress — so it
	 * has to outlive it and be there on the way back.
	 */
	it('keeps an open rewrite across a jump that replaces the window', async () => {
		const stored = {
			id: 'stored-user',
			role: 'user' as const,
			parts: [{ type: 'text' as const, text: 'original question' }],
		};
		const props = renderChatProps({
			initialMessages: [stored],
			initialWindow: {
				oldest: 10,
				newest: 10,
				hasOlder: true,
				hasNewer: true,
			},
		});
		const rendered = render(<AgentChat {...props} />);

		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
		const editor = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.clear(editor);
		await userEvent.type(editor, 'the rewrite worth keeping');

		// Jump to the oldest page: a window that does not contain the message.
		// The rewrite lives in the composer, not in the replaced rows, so it
		// survives the window swap without any bookkeeping.
		vi.mocked(readThreadMessages).mockResolvedValueOnce({
			messages: [
				{
					id: 'oldest-user',
					role: 'user',
					parts: [{ type: 'text', text: 'the beginning' }],
				},
			],
			oldest: 1,
			newest: 1,
			hasOlder: false,
			hasNewer: true,
		});
		rendered.rerender(
			<AgentChat {...props} edgeRequest={{ edge: 'start', token: 1 }} />,
		);
		await waitFor(() =>
			expect(screen.queryByText('original question')).toBeNull(),
		);

		expect(editor).toHaveProperty('value', 'the rewrite worth keeping');
		expect(screen.getByText(/Editing a sent message/)).toBeDefined();
	});

	it('cancelling an edit restores the draft it displaced', async () => {
		renderChat({
			initialMessages: [
				{
					id: 'stored-user',
					role: 'user',
					parts: [{ type: 'text', text: 'original question' }],
				},
			],
		});
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'half-written thought');

		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
		expect(input).toHaveProperty('value', 'original question');

		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(input).toHaveProperty('value', 'half-written thought');
		expect(screen.queryByText(/Editing a sent message/)).toBeNull();
	});

	it('does not regenerate a failed turn while the route holds the thread', () => {
		chat.status = 'error';
		chat.error = new Error('the reply failed');
		renderChat({
			busyReason: 'Compacting the context — sending resumes when it finishes.',
			initialMessages: [
				{
					id: 'failed-user',
					role: 'user',
					parts: [{ type: 'text', text: 'retry me' }],
				},
			],
		});
		const retry = screen.getByRole('button', { name: 'Retry' });

		expect(retry.hasAttribute('disabled')).toBe(true);
		fireEvent.click(retry);
		expect(chat.regenerate).not.toHaveBeenCalled();
	});

	/**
	 * `useChat` puts the response body in `error.message`, so a designed refusal
	 * arrives as raw JSON. A 409 is never a connectivity failure and must read
	 * as the wait it is — while anything unrecognized is still shown, because
	 * swallowing it hides the only description of an unforeseen failure.
	 */
	it('says a busy thread in words and shows an unknown failure as it came', () => {
		chat.status = 'error';
		chat.error = new Error('{"error":"AGENT_THREAD_BUSY"}');
		const props = renderChatProps({
			initialMessages: [
				{
					id: 'stored-user',
					role: 'user',
					parts: [{ type: 'text', text: 'question' }],
				},
			],
		});
		const rendered = render(<AgentChat {...props} />);

		expect(screen.getByText(/busy with a running turn/i)).toBeDefined();
		expect(screen.queryByText(/AGENT_THREAD_BUSY/)).toBeNull();

		chat.error = new Error('The upstream provider dropped the stream.');
		rendered.rerender(<AgentChat {...props} />);
		expect(
			screen.getByText('The upstream provider dropped the stream.'),
		).toBeDefined();
	});

	it('adds a compaction marker without losing draft, edit, or failed retry state', async () => {
		chat.status = 'error';
		chat.error = new Error('failed');
		const props = {
			initialMessages: [
				{
					id: 'failed-user',
					role: 'user' as const,
					parts: [{ type: 'text' as const, text: 'failed turn' }],
				},
			],
		};
		const rendered = render(<AgentChat {...renderChatProps(props)} />);
		const input = screen.getByRole('textbox', { name: 'Message the agent' });
		await userEvent.type(input, 'keep this draft');
		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));

		rendered.rerender(
			<AgentChat
				{...renderChatProps({
					...props,
					compactionMessage: {
						id: 'compaction-1',
						role: 'assistant',
						parts: [{ type: 'text', text: 'summary' }],
						metadata: { kind: 'compaction', model: 'test-model' },
					},
				})}
			/>,
		);

		// The rewrite is in the composer; the displaced draft comes back on cancel.
		expect(input).toHaveProperty('value', 'failed turn');
		expect(screen.getByText(/Editing a sent message/)).toBeDefined();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
		expect(await screen.findByText(/Context compacted/)).toBeDefined();

		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(input).toHaveProperty('value', 'keep this draft');
	});

	it('does not append a tail compaction marker into a middle window', () => {
		const props = renderChatProps({
			initialMessages: [
				{
					id: 'middle-user',
					role: 'user',
					parts: [{ type: 'text', text: 'middle' }],
				},
			],
			initialWindow: {
				oldest: 10,
				newest: 10,
				hasOlder: true,
				hasNewer: true,
			},
		});
		const rendered = render(<AgentChat {...props} />);

		rendered.rerender(
			<AgentChat
				{...props}
				compactionMessage={{
					id: 'compaction-tail',
					role: 'assistant',
					parts: [{ type: 'text', text: 'summary' }],
					metadata: { kind: 'compaction', model: 'test-model' },
				}}
			/>,
		);

		expect(screen.queryByText(/Context compacted/)).toBeNull();
	});

	it('marks a stopped partial reply as interrupted and reconciles the index', async () => {
		chat.status = 'streaming';
		const assistant = {
			id: 'partial-assistant',
			role: 'assistant' as const,
			parts: [{ type: 'text' as const, text: 'partial answer' }],
		};
		const props = renderChatProps({ initialMessages: [assistant] });
		const rendered = render(<AgentChat {...props} />);

		await userEvent.click(
			screen.getByRole('button', { name: 'Stop generating' }),
		);
		expect(chat.stop).toHaveBeenCalledTimes(1);
		chat.status = 'error';
		chat.error = new Error('aborted');
		rendered.rerender(<AgentChat {...props} />);
		act(() => chat.onFinish?.({ message: assistant, isAbort: true }));

		expect(await screen.findByText('Interrupted')).toBeDefined();
		expect(screen.getByText('partial answer')).toBeDefined();
		expect(storeLoad).toHaveBeenCalledWith(true);
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});

	it('shows interrupted status even when the stopped assistant has no text', () => {
		renderChat({
			initialMessages: [
				{
					id: 'empty-interrupted',
					role: 'assistant',
					parts: [],
					metadata: { interrupted: true },
				},
			],
		});
		expect(screen.getByText('Interrupted')).toBeDefined();
	});

	it('appends an aborted assistant callback that was not in local messages yet', () => {
		renderChat();
		const assistant = {
			id: 'late-aborted-assistant',
			role: 'assistant' as const,
			parts: [],
		};

		act(() => chat.onFinish?.({ message: assistant, isAbort: true }));

		expect(screen.getByText('Interrupted')).toBeDefined();
		expect(storeLoad).toHaveBeenCalledWith(true);
	});
});

describe('AgentChat earlier pages', () => {
	it('stops automatic pagination after failure until the user retries', async () => {
		const retry = deferred<Awaited<ReturnType<typeof readThreadMessages>>>();
		vi.mocked(readThreadMessages)
			.mockRejectedValueOnce(new Error('offline'))
			.mockReturnValueOnce(retry.promise);
		renderChat({
			initialMessages: [{ id: 'message-10', role: 'user', parts: [] }],
			initialWindow: {
				oldest: 10,
				newest: 10,
				hasOlder: true,
				hasNewer: false,
			},
		});

		act(() => observers.find((observer) => !observer.disconnected)?.fire(true));

		expect(
			await screen.findByText('Earlier messages could not be loaded.'),
		).toBeDefined();
		expect(observers.filter((observer) => !observer.disconnected)).toHaveLength(
			0,
		);
		expect(readThreadMessages).toHaveBeenCalledTimes(1);

		await userEvent.click(
			screen.getByRole('button', { name: 'Try loading earlier messages' }),
		);
		expect(
			screen.queryByText('Earlier messages could not be loaded.'),
		).toBeNull();
		expect(readThreadMessages).toHaveBeenCalledTimes(2);

		retry.resolve({
			messages: [{ id: 'message-1', role: 'user', parts: [] }],
			oldest: 1,
			newest: 1,
			hasOlder: false,
			hasNewer: true,
		});
		await waitFor(() =>
			expect(
				screen.queryByRole('button', { name: 'Try loading earlier messages' }),
			).toBeNull(),
		);
	});
});

/**
 * Opening a thread fresh used to render every mention as a raw uuid with no
 * preview: the index behind those names was only loaded by the mention list or
 * by an upload, so it stayed empty until one of those happened to run.
 */
describe('AgentChat file references', () => {
	const mention = {
		id: 'with-mention',
		role: 'user' as const,
		parts: [
			{
				type: 'text' as const,
				text: 'mirá @f:0198c9a2-1111-7000-8000-abcdefabcdef',
			},
		],
	};

	it('loads the storage index when the transcript references a file', async () => {
		renderChat({ initialMessages: [mention] });
		await waitFor(() => expect(storage.load).toHaveBeenCalledTimes(1));
	});

	it('does not load it for a thread that never touched a file', () => {
		renderChat({
			initialMessages: [
				{ id: 'plain', role: 'user', parts: [{ type: 'text', text: 'hola' }] },
			],
		});
		expect(storage.load).not.toHaveBeenCalled();
	});

	it('leaves an index that is already loaded alone', () => {
		storage.status = 'ready';
		renderChat({ initialMessages: [mention] });
		expect(storage.load).not.toHaveBeenCalled();
	});
});
