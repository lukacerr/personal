import { afterEach, describe, expect, test } from 'bun:test';
import { threadMessagesKey } from '@api/agent-cache';
import { modelOverride } from '@api/agent-models';
import { AGENT_MAX_STEPS } from '@api/agent-settings';
import { tavilyOverride } from '@api/agent-tools';
import { cache, db } from '@api/env';
import { agentMessage, agentThread } from '@api/schema';
import type { UIMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { asc, eq, inArray } from 'drizzle-orm';
import { json, request } from './helpers';

const createdThreadIds = new Set<string>();

afterEach(async () => {
	modelOverride.resolve = undefined;
	tavilyOverride.execute = undefined;
	if (createdThreadIds.size === 0) return;
	const ids = [...createdThreadIds];
	createdThreadIds.clear();
	await db.delete(agentThread).where(inArray(agentThread.id, ids));
	await Promise.all(ids.map((id) => cache.del(threadMessagesKey(id))));
});

async function createThread() {
	const id = Bun.randomUUIDv7();
	createdThreadIds.add(id);
	const response = await json('/agent/threads', 'POST', { id });
	expect(response.status).toBe(201);
	return id;
}

function chatBody(threadId: string, overrides: Record<string, unknown> = {}) {
	return {
		threadId,
		model: 'claude-sonnet-5',
		reasoning: 'low',
		tools: [],
		message: {
			id: Bun.randomUUIDv7(),
			role: 'user',
			parts: [{ type: 'text', text: 'feature request' }],
		},
		...overrides,
	};
}

const usage = {
	inputTokens: {
		total: 3,
		noCache: 3,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 7, text: 7, reasoning: undefined },
};

function textResult(text: string) {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: 'stream-start' as const, warnings: [] },
				{ type: 'text-start' as const, id: 'text-1' },
				{ type: 'text-delta' as const, id: 'text-1', delta: text },
				{ type: 'text-end' as const, id: 'text-1' },
				{
					type: 'finish' as const,
					finishReason: { unified: 'stop' as const, raw: undefined },
					usage,
				},
			],
		}),
	};
}

function toolResult() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: 'stream-start' as const, warnings: [] },
				{ type: 'tool-input-start' as const, id: 'call-1', toolName: 'tavily' },
				{
					type: 'tool-input-delta' as const,
					id: 'call-1',
					delta: '{"query":"bun"}',
				},
				{ type: 'tool-input-end' as const, id: 'call-1' },
				{
					type: 'tool-call' as const,
					toolCallId: 'call-1',
					toolName: 'tavily',
					input: '{"query":"bun"}',
				},
				{
					type: 'finish' as const,
					finishReason: { unified: 'tool-calls' as const, raw: undefined },
					usage,
				},
			],
		}),
	};
}

function rows(threadId: string) {
	return db
		.select()
		.from(agentMessage)
		.where(eq(agentMessage.threadId, threadId))
		.orderBy(asc(agentMessage.position));
}

async function waitForRows(threadId: string, count: number) {
	let found = await rows(threadId);
	for (let attempt = 0; attempt < 120 && found.length !== count; attempt++) {
		await Bun.sleep(25);
		found = await rows(threadId);
	}
	return found;
}

describe('agent chat controls', () => {
	test('accepts the max steps ceiling and audits it', async () => {
		const id = await createThread();
		const model = new MockLanguageModelV4({
			doStream: [toolResult(), textResult('large step budget')],
		});
		modelOverride.resolve = () => model;
		tavilyOverride.execute = async (input) => ({
			query: input.query,
			results: [],
		});

		await (
			await json(
				'/agent/chat',
				'POST',
				chatBody(id, {
					model: 'deepseek/deepseek-v4-pro-0813',
					reasoning: 'off',
					tools: ['tavily'],
					maxSteps: AGENT_MAX_STEPS,
					temperature: 0.4,
				}),
			)
		).text();
		const stored = await waitForRows(id, 2);

		expect(model.doStreamCalls).toHaveLength(2);
		expect(model.doStreamCalls[0]?.temperature).toBe(0.4);
		expect(stored[1]?.metadata).toMatchObject({
			maxSteps: AGENT_MAX_STEPS,
			temperature: 0.4,
		});
	});

	test('defaults max steps and omits absent temperature from streamText', async () => {
		const id = await createThread();
		const model = new MockLanguageModelV4({
			doStream: [textResult('defaults')],
		});
		modelOverride.resolve = () => model;
		await (await json('/agent/chat', 'POST', chatBody(id))).text();
		const stored = await waitForRows(id, 2);

		expect(model.doStreamCalls[0]?.temperature).toBeUndefined();
		expect(stored[1]?.metadata?.maxSteps).toBe(5);
		expect(stored[1]?.metadata).not.toHaveProperty('temperature');
	});

	test('rejects unsupported combinations and out-of-range controls', async () => {
		const id = await createThread();
		for (const overrides of [
			{ model: 'claude-sonnet-5', reasoning: 'off', temperature: 1 },
			{ model: 'claude-haiku-4-5', reasoning: 'off', temperature: 1.5 },
			{
				model: 'deepseek/deepseek-v4-pro-0813',
				reasoning: 'high',
				temperature: 1,
			},
		]) {
			const response = await json(
				'/agent/chat',
				'POST',
				chatBody(id, overrides),
			);
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({
				error: 'AGENT_TEMPERATURE_UNSUPPORTED',
			});
		}

		for (const overrides of [
			{ maxSteps: 0 },
			{ maxSteps: 1.5 },
			// A step budget no run should reach is a cost bug, not a preference.
			{ maxSteps: AGENT_MAX_STEPS + 1 },
			{ temperature: -0.1 },
			{ temperature: 2.1 },
		])
			expect(
				(await json('/agent/chat', 'POST', chatBody(id, overrides))).status,
			).toBe(422);

		const misaligned = await json(
			'/agent/chat',
			'POST',
			chatBody(id, {
				model: 'deepseek/deepseek-v4-pro-0813',
				reasoning: 'off',
				temperature: 0.05,
			}),
		);
		expect(misaligned.status).toBe(422);
		expect(await misaligned.json()).toEqual({
			error: 'AGENT_TEMPERATURE_UNSUPPORTED',
		});

		const model = new MockLanguageModelV4({
			doStream: [textResult('aligned')],
		});
		modelOverride.resolve = () => model;
		const aligned = await json(
			'/agent/chat',
			'POST',
			chatBody(id, {
				model: 'deepseek/deepseek-v4-pro-0813',
				reasoning: 'off',
				temperature: 0.3,
			}),
		);
		expect(aligned.status).toBe(200);
		await aligned.text();
		expect(model.doStreamCalls[0]?.temperature).toBe(0.3);
	});
});

describe('agent aborted streams', () => {
	test('persists partial reasoning and tool parts atomically on actual abort', async () => {
		const id = await createThread();
		const abort = new AbortController();
		const model = new MockLanguageModelV4({
			doStream: async ({ abortSignal }) => {
				const chunks = [
					{ type: 'stream-start' as const, warnings: [] },
					{ type: 'reasoning-start' as const, id: 'reason-1' },
					{
						type: 'reasoning-delta' as const,
						id: 'reason-1',
						delta: 'partial reasoning',
					},
					{
						type: 'tool-input-start' as const,
						id: 'partial-tool',
						toolName: 'tavily',
					},
					{
						type: 'tool-input-delta' as const,
						id: 'partial-tool',
						delta: '{"query":"partial lookup"',
					},
				];
				let index = 0;
				return {
					stream: new ReadableStream({
						async pull(controller) {
							if (index < chunks.length) {
								controller.enqueue(chunks[index++]);
								return;
							}
							await new Promise<void>((resolve) =>
								abortSignal?.addEventListener('abort', () => resolve(), {
									once: true,
								}),
							);
							controller.error(abortSignal?.reason);
						},
					}),
				};
			},
		});
		modelOverride.resolve = () => model;
		const response = await request('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(chatBody(id, { tools: ['tavily'], maxSteps: 7 })),
			signal: abort.signal,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error('chat response has no body');
		const decoder = new TextDecoder();
		let streamed = '';
		while (!streamed.includes('partial lookup')) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error('stream ended before partial tool input');
			streamed += decoder.decode(chunk.value, { stream: true });
		}
		abort.abort(new DOMException('stopped by test', 'AbortError'));
		while (!(await reader.read()).done) {}

		const stored = await waitForRows(id, 2);
		expect(stored.map((row) => row.role)).toEqual(['user', 'assistant']);
		expect(stored[1]?.metadata).toMatchObject({
			interrupted: true,
			model: 'claude-sonnet-5',
			reasoning: 'low',
			tools: ['tavily'],
			maxSteps: 7,
		});
		expect(typeof stored[1]?.metadata?.durationMs).toBe('number');
		expect(stored[1]?.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'reasoning',
					text: 'partial reasoning',
					state: 'streaming',
				}),
				expect.objectContaining({
					type: 'tool-tavily',
					state: 'input-streaming',
				}),
			]),
		);
		const [thread] = await db
			.select({ owner: agentThread.mutationOwner })
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(thread?.owner).toBeNull();

		const reload = await request(`/agent/threads/${id}/messages`);
		const window = (await reload.json()) as { messages: UIMessage[] };
		expect(window.messages).toHaveLength(2);
		expect(window.messages[1]).toMatchObject({
			role: 'assistant',
			metadata: { interrupted: true },
		});
	});

	test('persists an interrupted assistant even before content arrives', async () => {
		const id = await createThread();
		const abort = new AbortController();
		const model = new MockLanguageModelV4({
			doStream: async ({ abortSignal }) => {
				let started = false;
				return {
					stream: new ReadableStream({
						async pull(controller) {
							if (!started) {
								started = true;
								controller.enqueue({ type: 'stream-start', warnings: [] });
								return;
							}
							if (!abortSignal?.aborted)
								await new Promise<void>((resolve) =>
									abortSignal?.addEventListener('abort', () => resolve(), {
										once: true,
									}),
								);
							controller.error(abortSignal?.reason);
						},
					}),
				};
			},
		});
		modelOverride.resolve = () => model;
		const response = await request('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(chatBody(id)),
			signal: abort.signal,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error('chat response has no body');
		await reader.read();
		abort.abort(new DOMException('stopped before content', 'AbortError'));
		while (!(await reader.read()).done) {}

		const stored = await waitForRows(id, 2);
		expect(stored.map((row) => row.role)).toEqual(['user', 'assistant']);
		expect(stored[1]?.metadata).toMatchObject({
			interrupted: true,
			model: 'claude-sonnet-5',
		});
	});

	test('does not misclassify a provider stream error as an interruption', async () => {
		const id = await createThread();
		const model = new MockLanguageModelV4({
			doStream: {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start' as const, warnings: [] },
						{ type: 'text-start' as const, id: 'text-1' },
						{ type: 'text-delta' as const, id: 'text-1', delta: 'partial' },
						{ type: 'error' as const, error: new Error('provider failed') },
					],
				}),
			},
		});
		modelOverride.resolve = () => model;
		await (await json('/agent/chat', 'POST', chatBody(id))).text();

		await Bun.sleep(50);
		expect(await rows(id)).toEqual([]);
		const [thread] = await db
			.select({ owner: agentThread.mutationOwner })
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(thread?.owner).toBeNull();
	});
});

describe('agent bulk delete', () => {
	test('returns actual deleted ids, cascades, and drops each cache best-effort', async () => {
		const first = await createThread();
		const second = await createThread();
		const missing = Bun.randomUUIDv7();
		await db.insert(agentMessage).values([
			{
				id: Bun.randomUUIDv7(),
				threadId: first,
				position: 1,
				role: 'user',
				parts: [{ type: 'text', text: 'first' }],
			},
			{
				id: Bun.randomUUIDv7(),
				threadId: second,
				position: 1,
				role: 'user',
				parts: [{ type: 'text', text: 'second' }],
			},
		]);
		await cache.set(threadMessagesKey(first), { stale: true });
		await cache.set(threadMessagesKey(second), { stale: true });

		const response = await json('/agent/threads/bulk/delete', 'POST', {
			ids: [second, missing, first],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: [second, first] });
		expect(await rows(first)).toEqual([]);
		expect(await rows(second)).toEqual([]);
		expect(await cache.get(threadMessagesKey(first))).toBeNull();
		expect(await cache.get(threadMessagesKey(second))).toBeNull();
	});

	test('requires 1..100 unique UUIDs', async () => {
		const duplicate = Bun.randomUUIDv7();
		for (const ids of [
			[],
			[duplicate, duplicate],
			Array.from({ length: 101 }, () => Bun.randomUUIDv7()),
		])
			expect(
				(await json('/agent/threads/bulk/delete', 'POST', { ids })).status,
			).toBe(422);
	});
});
