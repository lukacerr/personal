import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	buildSnippet,
	CARRIED_CONTEXT_BUDGET_CHARS,
	compactionWindow,
	currentContextPrompt,
	promptWindow,
	SNIPPET_RADIUS,
	SYSTEM_PROMPT,
} from '@api/agent';
import { createThreadMessagesCache, threadMessagesKey } from '@api/agent-cache';
import { AGENT_MODELS, modelOverride } from '@api/agent-models';
import {
	AGENT_MAX_STEPS,
	AGENT_SETTINGS_KEY,
	agentSettingsStore,
} from '@api/agent-settings';
import { tavilyOverride } from '@api/agent-tools';
import { cache, db } from '@api/env';
import { agentMessage, agentThread } from '@api/schema';
import type { UIMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { json, request } from './helpers';

const createdThreadIds = new Set<string>();

afterEach(async () => {
	modelOverride.resolve = undefined;
	tavilyOverride.execute = undefined;
	await cache.del(AGENT_SETTINGS_KEY);
	if (createdThreadIds.size === 0) return;
	const ids = [...createdThreadIds];
	createdThreadIds.clear();
	await db.delete(agentThread).where(inArray(agentThread.id, ids));
	await Promise.all(ids.map((id) => cache.del(threadMessagesKey(id))));
});

async function createThread(id = Bun.randomUUIDv7()) {
	createdThreadIds.add(id);
	const response = await json('/agent/threads', 'POST', { id });
	expect(response.status).toBe(201);
	return id;
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

function tavilyCallResult() {
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

type DoStream = NonNullable<
	NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream']
>;

function useMockModel(results: DoStream) {
	const model = new MockLanguageModelV4({ doStream: results });
	modelOverride.resolve = () => model;
	return model;
}

function chatBody(
	threadId: string,
	text: string,
	overrides?: Record<string, unknown>,
) {
	return {
		threadId,
		model: 'claude-sonnet-5',
		reasoning: 'low',
		tools: [],
		message: {
			id: Bun.randomUUIDv7(),
			role: 'user',
			parts: [{ type: 'text', text }],
		},
		...overrides,
	};
}

function threadRows(threadId: string) {
	return db
		.select()
		.from(agentMessage)
		.where(eq(agentMessage.threadId, threadId))
		.orderBy(asc(agentMessage.position));
}

async function mutationState(threadId: string) {
	const [thread] = await db
		.select({
			owner: agentThread.mutationOwner,
			expiresAt: agentThread.mutationExpiresAt,
		})
		.from(agentThread)
		.where(eq(agentThread.id, threadId))
		.limit(1);
	return thread;
}

/**
 * The local database carries production threads, so a pagination assertion can
 * only be exact over rows it owns: every seeded thread is anchored past any
 * real `updated_at` and tagged with a marker its search can filter by.
 */
const ANCHOR_MS = Date.UTC(2099, 0, 1);

async function seedThreads(titles: string[]) {
	const ids: string[] = [];
	for (const [index, title] of titles.entries()) {
		// uuidv7 ids grow with creation order, which is what the id tiebreak sorts.
		const id = await createThread();
		expect(
			(await json(`/agent/threads/${id}`, 'PATCH', { title })).status,
		).toBe(200);
		await db
			.update(agentThread)
			.set({ updatedAt: new Date(ANCHOR_MS + index * 60_000) })
			.where(eq(agentThread.id, id));
		ids.push(id);
	}
	return ids;
}

type ThreadPage = {
	threads: { id: string; title: string; updatedAt: number }[];
	nextCursor: { updatedAt: number; id: string } | null;
};

async function threadPage(search: string) {
	const response = await request(`/agent/threads?${search}`);
	expect(response.status).toBe(200);
	return { response, page: (await response.json()) as ThreadPage };
}

async function seedMessages(threadId: string, texts: string[]) {
	await db.insert(agentMessage).values(
		texts.map((text, index) => ({
			id: Bun.randomUUIDv7(),
			threadId,
			position: index + 1,
			role: index % 2 === 0 ? 'user' : 'assistant',
			parts: [{ type: 'text' as const, text }],
		})),
	);
}

type MessageWindow = {
	messages: UIMessage[];
	oldest: number | null;
	newest: number | null;
	hasOlder: boolean;
	hasNewer: boolean;
};

/** Persistence runs in the stream's onEnd, after the response body closed. */
async function waitFor<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
) {
	let value = await read();
	for (let attempt = 0; attempt < 120 && !ready(value); attempt++) {
		await Bun.sleep(25);
		value = await read();
	}
	return value;
}

describe('the system prompt', () => {
	/**
	 * The prompt is what tells the model which renderer features exist. A
	 * feature the web supports but the prompt never mentions is a feature the
	 * model will not use, so the two are kept in step deliberately — this test
	 * is the reminder, not a style check.
	 */
	test('declares every renderer capability the transcript supports', () => {
		for (const capability of [
			'==Highlighted text==',
			'$E = mc^2$',
			'```mermaid',
			'syntax highlighting',
			'task\n  lists',
		])
			expect(SYSTEM_PROMPT).toContain(capability);
	});

	test('warns about the currency ambiguity inline math creates', () => {
		expect(SYSTEM_PROMPT).toContain('100 USD');
		expect(SYSTEM_PROMPT).toContain('\\$100');
	});

	test("includes Luka's response preferences", () => {
		const prompt = SYSTEM_PROMPT.replaceAll(/\s+/g, ' ');
		for (const preference of [
			'Reply in Spanish unless Luka asks for another language.',
			'Do not hedge certainty',
			'no filler introductions or repetitive conclusions',
			'Avoid code comments unless they explain non-obvious reasoning.',
		])
			expect(prompt).toContain(preference);
	});

	/** Prompt caching is a prefix match, so nothing per-request may leak in. */
	test('is a constant, with nothing interpolated', () => {
		expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.normalize());
		expect(SYSTEM_PROMPT).not.toMatch(/\$\{/);
		expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	test("supplies Luka's local time and timezone per turn", () => {
		const prompt = currentContextPrompt(new Date('2026-08-23T18:21:51Z'));

		expect(prompt).toContain('Luka lives in San Nicolas, CABA, Argentina.');
		expect(prompt).toContain('2026-08-23 15:21:51 UTC-03:00');
		expect(prompt).toContain('America/Argentina/Buenos_Aires');
	});
});

describe('agent catalog', () => {
	test('publishes the model registry and the tool registry', async () => {
		const response = await request('/agent/catalog');
		expect(response.status).toBe(200);
		const catalog = (await response.json()) as {
			models: { id: string; reasoning: { levels: string[] } }[];
			tools: { name: string }[];
		};
		/**
		 * Which models the selector offers is pinned once, in
		 * `agent-models.test.ts`; what this asserts is that the endpoint serves
		 * that list and not a subset of it.
		 */
		expect(catalog.models.map((model) => model.id)).toEqual(
			AGENT_MODELS.map((model) => model.id),
		);
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['tavily']);
	});
});

describe('agent threads', () => {
	test('creating is idempotent per id', async () => {
		const id = await createThread();
		const retry = await json('/agent/threads', 'POST', { id });
		expect(retry.status).toBe(201);
		const rows = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toBe('New chat');
	});

	test('rejects a non-uuid id', async () => {
		const response = await json('/agent/threads', 'POST', { id: 'nope' });
		expect(response.status).toBe(422);
	});

	test('lists threads by recency with epoch-ms timestamps', async () => {
		const first = await createThread();
		await Bun.sleep(5);
		const second = await createThread();
		const response = await request('/agent/threads');
		expect(response.status).toBe(200);
		const { threads } = (await response.json()) as {
			threads: { id: string; createdAt: number; updatedAt: number }[];
		};
		const ours = threads.filter((thread) =>
			[first, second].includes(thread.id),
		);
		expect(ours.map((thread) => thread.id)).toEqual([second, first]);
		for (const thread of ours) {
			expect(typeof thread.createdAt).toBe('number');
			expect(typeof thread.updatedAt).toBe('number');
		}
	});

	test('renames a thread and 404s for strangers', async () => {
		const id = await createThread();
		const renamed = await json(`/agent/threads/${id}`, 'PATCH', {
			title: 'Trip planning',
		});
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as { title: string }).title).toBe(
			'Trip planning',
		);

		const missing = await json(
			`/agent/threads/${Bun.randomUUIDv7()}`,
			'PATCH',
			{ title: 'Ghost' },
		);
		expect(missing.status).toBe(404);
	});

	test('deleting is idempotent and cascades to messages', async () => {
		const id = await createThread();
		useMockModel([textResult('adiós')]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'hola'))).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		const deleted = await request(`/agent/threads/${id}`, { method: 'DELETE' });
		expect(deleted.status).toBe(204);
		const again = await request(`/agent/threads/${id}`, { method: 'DELETE' });
		expect(again.status).toBe(204);

		expect(await threadRows(id)).toHaveLength(0);
		const messages = await request(`/agent/threads/${id}/messages`);
		expect(messages.status).toBe(404);
	});

	test('an empty thread lists no messages; a stranger 404s', async () => {
		const id = await createThread();
		const response = await request(`/agent/threads/${id}/messages`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			messages: [],
			oldest: null,
			newest: null,
			hasOlder: false,
			hasNewer: false,
		});

		const missing = await request(
			`/agent/threads/${Bun.randomUUIDv7()}/messages`,
		);
		expect(missing.status).toBe(404);
	});
});

describe('agent chat', () => {
	test('streams the reply and persists the exchange', async () => {
		const id = await createThread();
		useMockModel([textResult('Hola desde el mock')]);

		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(id, '¿Me ayudás con Bun?'),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const body = await response.text();
		expect(body).toContain('Hola desde el mock');
		expect(body).toContain('[DONE]');

		const rows = await waitFor(
			() => threadRows(id),
			(r) => r.length === 2,
		);
		expect(rows.map((row) => [row.role, row.position])).toEqual([
			['user', 1],
			['assistant', 2],
		]);
		expect(JSON.stringify(rows[1]?.parts)).toContain('Hola desde el mock');
		expect(rows[1]?.metadata?.model).toBe('claude-sonnet-5');
		expect(rows[1]?.metadata?.reasoning).toBe('low');
		expect(typeof rows[1]?.metadata?.totalTokens).toBe('number');
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });

		const { page } = await threadPage('');
		expect(page.threads.find((thread) => thread.id === id)?.title).toBe(
			'¿Me ayudás con Bun?',
		);

		const messages = await request(`/agent/threads/${id}/messages`);
		const stored = (await messages.json()) as MessageWindow;
		expect(stored.messages.map((message) => message.role)).toEqual([
			'user',
			'assistant',
		]);
	});

	test('persists the stats bar metadata with the assistant turn', async () => {
		const id = await createThread();
		useMockModel([textResult('con métricas')]);

		await (
			await json(
				'/agent/chat',
				'POST',
				chatBody(id, 'medime el turno', { tools: ['tavily'] }),
			)
		).text();

		const rows = await waitFor(
			() => threadRows(id),
			(r) => r.length === 2,
		);
		const metadata = rows[1]?.metadata;
		expect(metadata?.model).toBe('claude-sonnet-5');
		expect(metadata?.reasoning).toBe('low');
		// The tools granted for this turn, so the bar can say what was available.
		expect(metadata?.tools).toEqual(['tavily']);
		expect(typeof metadata?.totalTokens).toBe('number');
		expect(typeof metadata?.outputTokens).toBe('number');
		expect(typeof metadata?.durationMs).toBe('number');
		expect(metadata?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
		expect(typeof metadata?.firstTokenMs).toBe('number');
		expect(metadata?.firstTokenMs ?? -1).toBeGreaterThanOrEqual(0);
	});

	test('follow-ups read the history from the cache, not Neon', async () => {
		const id = await createThread();
		const model = useMockModel([
			textResult('Hola desde el mock'),
			textResult('sigo acá'),
		]);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'primer turno'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		// If the follow-up still sees the first exchange, it came from Redis.
		await db.delete(agentMessage).where(eq(agentMessage.threadId, id));

		await (
			await json('/agent/chat', 'POST', chatBody(id, 'segundo turno'))
		).text();
		await waitFor(
			() => Promise.resolve(model.doStreamCalls),
			(c) => c.length === 2,
		);
		const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
		expect(prompt).toContain('primer turno');
		expect(prompt).toContain('Hola desde el mock');
		expect(prompt).toContain('segundo turno');
	});

	test('a stale cache revision is ignored after a failed replacement', async () => {
		const stored = new Map<string, unknown>();
		let failWrites = false;
		const historyCache = createThreadMessagesCache({
			cache: {
				get: async (key) => stored.get(key),
				set: async (key, value) => {
					if (failWrites) throw new Error('redis unavailable');
					stored.set(key, value);
				},
				del: async (key) => stored.delete(key),
			},
		});
		const incarnation = Bun.randomUUIDv7();
		const first = [chatBody(Bun.randomUUIDv7(), 'uno').message] as UIMessage[];
		await historyCache.write('thread', incarnation, 1, first);
		failWrites = true;
		await historyCache.write('thread', incarnation, 2, [
			...first,
			chatBody(Bun.randomUUIDv7(), 'dos').message,
		] as UIMessage[]);

		expect(await historyCache.read('thread', incarnation, 2)).toBeUndefined();
	});

	test('delete and recreate never reads stale history when cache deletion failed', async () => {
		const id = await createThread();
		useMockModel([textResult('respuesta vieja')]);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'historia vieja'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
		const stale = await cache.get(threadMessagesKey(id));
		expect(stale).not.toBeNull();

		await request(`/agent/threads/${id}`, { method: 'DELETE' });
		await createThread(id);
		await db
			.update(agentThread)
			.set({ revision: 1 })
			.where(eq(agentThread.id, id));
		await cache.set(threadMessagesKey(id), stale);
		const model = useMockModel([textResult('respuesta nueva')]);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'historia nueva'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
		expect(prompt).toContain('historia nueva');
		expect(prompt).not.toContain('historia vieja');
	});

	test('a stale cached prefix cannot truncate newer database history', async () => {
		const id = await createThread();
		const model = useMockModel([
			textResult('respuesta uno'),
			textResult('respuesta dos'),
			textResult('respuesta tres'),
		]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'turno uno'))).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
		await (await json('/agent/chat', 'POST', chatBody(id, 'turno dos'))).text();
		const firstTwoExchanges = await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 4,
		);

		await cache.set(threadMessagesKey(id), {
			revision: 1,
			messages: firstTwoExchanges.slice(0, 2).map((row) => ({
				id: row.id,
				role: row.role,
				parts: row.parts,
				...(row.metadata === null ? {} : { metadata: row.metadata }),
			})),
		});
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'turno tres'))
		).text();
		const rows = await waitFor(
			() => threadRows(id),
			(found) => found.length === 6,
		);

		expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
			'turno dos',
		);
	});

	test('rejects a concurrent chat before starting a second provider call', async () => {
		const id = await createThread();
		useMockModel([textResult('base')]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'inicio'))).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		let releaseSlow: (() => void) | undefined;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const model = new MockLanguageModelV4({
			doStream: async () => {
				await slow;
				return textResult('respuesta lenta');
			},
		});
		modelOverride.resolve = () => model;

		const slowResponse = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'turno lento'),
		);
		const slowBody = slowResponse.text();
		await waitFor(
			() => Promise.resolve(model.doStreamCalls.length),
			(count) => count === 1,
		);
		const concurrent = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'turno rechazado'),
		);
		expect(concurrent.status).toBe(409);
		expect(await concurrent.json()).toEqual({ error: 'AGENT_THREAD_BUSY' });
		expect(model.doStreamCalls).toHaveLength(1);
		const compact = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(compact.status).toBe(409);
		expect(await compact.json()).toEqual({ error: 'AGENT_THREAD_BUSY' });
		expect(model.doGenerateCalls).toHaveLength(0);
		releaseSlow?.();
		await slowBody;
		const rows = await waitFor(
			() => threadRows(id),
			(found) => found.length === 4,
		);
		expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4]);
		expect(JSON.stringify(rows)).toContain('turno lento');
		expect(JSON.stringify(rows)).not.toContain('turno rechazado');
	});

	test('an expired mutation lease is recoverable', async () => {
		const id = await createThread();
		await db.execute(sql`
			update ${agentThread}
			set mutation_owner = ${Bun.randomUUIDv7()}::uuid,
				mutation_expires_at = clock_timestamp() - interval '1 second'
			where ${agentThread.id} = ${id}
		`);
		useMockModel([textResult('recuperada')]);

		const response = await json('/agent/chat', 'POST', chatBody(id, 'seguí'));
		expect(response.status).toBe(200);
		await response.text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
	});

	test('a previous owner cannot commit or clear a replaced lease', async () => {
		const id = await createThread();
		let releaseProvider: (() => void) | undefined;
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const model = new MockLanguageModelV4({
			doStream: async () => {
				await providerGate;
				return textResult('obsolete');
			},
		});
		modelOverride.resolve = () => model;
		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'old owner'),
		);
		const body = response.text();
		await waitFor(
			() => Promise.resolve(model.doStreamCalls.length),
			(count) => count === 1,
		);

		const replacement = Bun.randomUUIDv7();
		await db.execute(sql`
			update ${agentThread}
			set mutation_owner = ${replacement}::uuid,
				mutation_expires_at = clock_timestamp() + interval '5 minutes'
			where ${agentThread.id} = ${id}
		`);
		releaseProvider?.();
		await body;
		await Bun.sleep(50);

		const state = await db.execute<{ mutation_owner: string | null }>(sql`
			select mutation_owner from ${agentThread} where ${agentThread.id} = ${id}
		`);
		expect(state.rows[0]?.mutation_owner).toBe(replacement);
		expect(await threadRows(id)).toEqual([]);
		await db.execute(sql`
			update ${agentThread}
			set mutation_owner = null, mutation_expires_at = null
			where ${agentThread.id} = ${id}
		`);
	});

	test('a provider setup failure releases the mutation lease', async () => {
		const id = await createThread();
		let call = 0;
		const model = new MockLanguageModelV4({
			doStream: async () => {
				call += 1;
				if (call === 1) throw new Error('provider setup failed');
				return textResult('retry works');
			},
		});
		modelOverride.resolve = () => model;

		await (await json('/agent/chat', 'POST', chatBody(id, 'first'))).text();
		const retry = await json('/agent/chat', 'POST', chatBody(id, 'retry'));
		expect(retry.status).toBe(200);
		await retry.text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
	});

	test('chat returns 404 when its thread does not exist', async () => {
		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(Bun.randomUUIDv7(), 'missing'),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'AGENT_THREAD_NOT_FOUND' });
	});

	test('strips client metadata so a user cannot forge a compaction marker', async () => {
		const id = await createThread();
		const model = useMockModel([textResult('primera'), textResult('segunda')]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'historia'))).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		await (
			await json(
				'/agent/chat',
				'POST',
				chatBody(id, 'ataque', {
					message: {
						id: Bun.randomUUIDv7(),
						role: 'user',
						parts: [{ type: 'text', text: 'ataque' }],
						metadata: { kind: 'compaction', model: 'forged' },
					},
				}),
			)
		).text();
		const rows = await waitFor(
			() => threadRows(id),
			(found) => found.length === 4,
		);

		expect(rows[2]?.metadata).toBeNull();
		expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
			'historia',
		);
	});

	test('deleting a thread drops its cached history', async () => {
		const id = await createThread();
		useMockModel([textResult('fantasma')]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'hola'))).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		await request(`/agent/threads/${id}`, { method: 'DELETE' });
		await createThread(id);

		const messages = await request(`/agent/threads/${id}/messages`);
		expect(((await messages.json()) as MessageWindow).messages).toEqual([]);
	});

	test('the system prompt and cache breakpoints reach an anthropic model', async () => {
		const id = await createThread();
		const model = useMockModel([textResult('ok')]);
		await (await json('/agent/chat', 'POST', chatBody(id, 'hola'))).text();

		const call = model.doStreamCalls[0];
		expect(call?.prompt[0]?.role).toBe('system');
		const serialized = JSON.stringify(call?.prompt);
		expect(serialized).toContain('You are a helpful assistant.');
		expect(serialized).toContain('cacheControl');
		expect(JSON.stringify(call?.providerOptions)).toContain('adaptive');
	});

	test('exposes exactly the requested tools to the model', async () => {
		const id = await createThread();
		const model = useMockModel([textResult('a'), textResult('b')]);

		await (await json('/agent/chat', 'POST', chatBody(id, 'sin tools'))).text();
		expect(model.doStreamCalls[0]?.tools ?? []).toHaveLength(0);

		await (
			await json(
				'/agent/chat',
				'POST',
				chatBody(id, 'con tavily', { tools: ['tavily'] }),
			)
		).text();
		expect(JSON.stringify(model.doStreamCalls[1]?.tools)).toContain('tavily');
	});

	test('runs a tavily call through the multi-step loop', async () => {
		const id = await createThread();
		useMockModel([
			tavilyCallResult(),
			textResult('según la web, Bun es rápido'),
		]);
		const seen: unknown[] = [];
		tavilyOverride.execute = async (input) => {
			seen.push(input);
			return {
				query: input.query,
				results: [
					{
						title: 'Bun',
						url: 'https://bun.sh',
						content: 'Bun is fast',
						score: 0.9,
					},
				],
			};
		};

		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'buscá bun', { tools: ['tavily'] }),
		);
		const body = await response.text();
		// On the wire tools travel as chunks; `tool-tavily` is the assembled part.
		expect(body).toContain('tool-output-available');
		expect(body).toContain('"toolName":"tavily"');
		expect(seen).toEqual([
			{ query: 'bun', searchDepth: 'basic', maxResults: 5 },
		]);

		const rows = await waitFor(
			() => threadRows(id),
			(r) => r.length === 2,
		);
		const assistant = JSON.stringify(rows[1]?.parts);
		expect(assistant).toContain('tool-tavily');
		expect(assistant).toContain('https://bun.sh');
		expect(assistant).toContain('según la web');
	});

	test('regenerating a turn replaces the stale tail instead of appending', async () => {
		const id = await createThread();
		useMockModel([
			textResult('primera respuesta'),
			textResult('segunda respuesta'),
		]);
		const body = chatBody(id, 'contame algo');
		await (await json('/agent/chat', 'POST', body)).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);

		// A regenerate resends the same user message id.
		await (await json('/agent/chat', 'POST', body)).text();
		const rows = await waitFor(
			() => threadRows(id),
			(r) => r.length === 2 && JSON.stringify(r[1]?.parts).includes('segunda'),
		);
		expect(rows.map((row) => row.position)).toEqual([1, 2]);
		expect(JSON.stringify(rows[1]?.parts)).toContain('segunda respuesta');
	});

	test('rejects what the registries do not know', async () => {
		const id = await createThread();

		const model = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'x', { model: 'gpt-99' }),
		);
		expect(model.status).toBe(422);
		expect(((await model.json()) as { error: string }).error).toBe(
			'AGENT_MODEL_UNKNOWN',
		);

		const reasoning = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'x', { model: 'claude-opus-5', reasoning: 'off' }),
		);
		expect(reasoning.status).toBe(422);
		expect(((await reasoning.json()) as { error: string }).error).toBe(
			'AGENT_REASONING_UNKNOWN',
		);

		const novita = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'x', { model: 'qwen/qwen3.7-max', reasoning: 'high' }),
		);
		expect(novita.status).toBe(422);

		const tool = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'x', { tools: ['tavily', 'nope'] }),
		);
		expect(tool.status).toBe(422);
		expect(((await tool.json()) as { error: string }).error).toBe(
			'AGENT_TOOL_UNKNOWN',
		);

		const thread = await json(
			'/agent/chat',
			'POST',
			chatBody(Bun.randomUUIDv7(), 'x'),
		);
		expect(thread.status).toBe(404);

		const empty = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'x', {
				message: { id: Bun.randomUUIDv7(), role: 'user', parts: [] },
			}),
		);
		expect(empty.status).toBe(422);
	});

	test('a novita request without a level falls back to the model default', async () => {
		const id = await createThread();
		const model = useMockModel([
			textResult('desde novita'),
			textResult('sin pensar'),
		]);
		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'hola', {
				model: 'deepseek/deepseek-v4-flash-0731',
				reasoning: undefined,
			}),
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(model.doStreamCalls[0]?.providerOptions ?? {}).toEqual({
			novita: { reasoningEffort: 'high' },
		});

		const off = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'sin pensar', {
				model: 'minimax/minimax-m3',
				reasoning: 'off',
			}),
		);
		expect(off.status).toBe(200);
		await off.text();
		expect(model.doStreamCalls[1]?.providerOptions ?? {}).toEqual({
			novita: { thinking: { type: 'disabled' }, enable_thinking: false },
		});
	});
});

describe('agent thread pagination', () => {
	test('walks the index in pages that neither overlap nor skip', async () => {
		const marker = Bun.randomUUIDv7().slice(0, 8);
		const ids = await seedThreads([
			`${marker} uno`,
			`${marker} dos`,
			`${marker} tres`,
		]);

		const first = await threadPage(`limit=2&query=${marker}`);
		expect(first.page.threads.map((thread) => thread.id)).toEqual([
			ids[2],
			ids[1],
		]);
		const cursor = first.page.nextCursor;
		expect(cursor).toEqual({
			updatedAt: ANCHOR_MS + 60_000,
			id: ids[1] as string,
		});

		const second = await threadPage(
			`limit=2&query=${marker}&cursorUpdatedAt=${cursor?.updatedAt}&cursorId=${cursor?.id}`,
		);
		expect(second.page.threads.map((thread) => thread.id)).toEqual([ids[0]]);
		// The last page is the one that did not fill: no extra round trip to learn it.
		expect(second.page.nextCursor).toBeNull();
	});

	test('the id tiebreak keeps a page stable when two threads share updated_at', async () => {
		const marker = Bun.randomUUIDv7().slice(0, 8);
		const ids = await seedThreads([`${marker} a`, `${marker} b`]);
		await db
			.update(agentThread)
			.set({ updatedAt: new Date(ANCHOR_MS) })
			.where(inArray(agentThread.id, ids));

		const first = await threadPage(`limit=1&query=${marker}`);
		// Same clock, so the descending id decides — the later-created uuidv7 wins.
		expect(first.page.threads.map((thread) => thread.id)).toEqual([ids[1]]);

		const cursor = first.page.nextCursor;
		expect(cursor).toEqual({ updatedAt: ANCHOR_MS, id: ids[1] as string });
		const second = await threadPage(
			`limit=1&query=${marker}&cursorUpdatedAt=${cursor?.updatedAt}&cursorId=${cursor?.id}`,
		);
		expect(second.page.threads.map((thread) => thread.id)).toEqual([ids[0]]);
		expect(second.page.nextCursor).toBeNull();
	});

	test('half a cursor is a 422, not a silent first page', async () => {
		const updatedAt = await request(
			`/agent/threads?cursorUpdatedAt=${ANCHOR_MS}`,
		);
		expect(updatedAt.status).toBe(422);
		expect(((await updatedAt.json()) as { error: string }).error).toBe(
			'AGENT_CURSOR_INCOMPLETE',
		);

		const id = await request(`/agent/threads?cursorId=${Bun.randomUUIDv7()}`);
		expect(id.status).toBe(422);
		expect(((await id.json()) as { error: string }).error).toBe(
			'AGENT_CURSOR_INCOMPLETE',
		);
	});

	test('searches titles case-insensitively and treats a blank query as absent', async () => {
		const marker = Bun.randomUUIDv7().slice(0, 8);
		const ids = await seedThreads([`${marker} Trip planning`]);

		const found = await threadPage(`query=${marker.toUpperCase()}%20TRIP`);
		expect(found.page.threads.map((thread) => thread.id)).toEqual([ids[0]]);

		// A query of only spaces is not a filter; the index answers as usual.
		const blank = await threadPage('query=%20%20');
		expect(blank.page.threads.length).toBeGreaterThan(0);
		expect(blank.response.headers.get('etag')).not.toBeNull();
	});

	test('matches the LIKE metacharacters of a query literally', async () => {
		const marker = Bun.randomUUIDv7().slice(0, 8);
		/**
		 * Each pair is a title the escaped query must find and a title an
		 * unescaped `_` or `%` would drag in with it — the metacharacter has to be
		 * in the *query* to matter, since that is what becomes the pattern.
		 */
		const ids = await seedThreads([
			`${marker} plan_a`,
			`${marker} planXa`,
			`${marker} 100%`,
			`${marker} 100 y algo`,
		]);

		const underscore = await threadPage(`query=${marker}%20plan_a`);
		expect(underscore.page.threads.map((thread) => thread.id)).toEqual([
			ids[0],
		]);

		const percent = await threadPage(`query=${marker}%20100%25`);
		expect(percent.page.threads.map((thread) => thread.id)).toEqual([ids[2]]);

		// A title's own metacharacter is data: the substring still has to be there.
		const missing = await threadPage(`query=${marker}%20plana`);
		expect(missing.page.threads).toEqual([]);
	});

	test('only the default page is conditional', async () => {
		const marker = Bun.randomUUIDv7().slice(0, 8);
		await seedThreads([`${marker} uno`]);

		const first = await request('/agent/threads');
		const tag = first.headers.get('etag') ?? '';
		expect(tag).not.toBe('');
		expect(
			(await request('/agent/threads', { headers: { 'if-none-match': tag } }))
				.status,
		).toBe(304);

		/**
		 * A recut of the index is not the index: a tag per query string would
		 * claim freshness for a slice nobody remembered.
		 */
		for (const search of [
			'limit=10',
			`query=${marker}`,
			`cursorUpdatedAt=${ANCHOR_MS + 1}&cursorId=${Bun.randomUUIDv7()}`,
		]) {
			const response = await request(`/agent/threads?${search}`, {
				headers: { 'if-none-match': tag },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('etag')).toBeNull();
		}
	});

	test('stores recency clocks at millisecond precision for durable cursors', async () => {
		const id = await createThread();
		await db.execute(
			sql`update ${agentThread} set updated_at = '2099-01-01 00:00:00.123456'::timestamp where ${agentThread.id} = ${id}`,
		);
		const [stored] = await db
			.select({
				micros: sql<string>`to_char(${agentThread.updatedAt}, 'US')`,
			})
			.from(agentThread)
			.where(eq(agentThread.id, id));

		expect(stored?.micros).toBe('123000');
	});
});

describe('agent message window', () => {
	const texts = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete'];

	function positions(window: MessageWindow) {
		return [window.oldest, window.newest, window.hasOlder, window.hasNewer];
	}

	async function messageWindow(threadId: string, search: string) {
		const response = await request(
			`/agent/threads/${threadId}/messages${search}`,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as MessageWindow;
	}

	test('answers the newest page first and walks outwards from there', async () => {
		const id = await createThread();
		await seedMessages(id, texts);

		// No cursor: the tail of the thread, ascending, with room left behind it.
		const newest = await messageWindow(id, '?limit=3');
		expect(newest.messages.map((message) => message.id)).toHaveLength(3);
		expect(JSON.stringify(newest.messages)).toContain('siete');
		expect(positions(newest)).toEqual([5, 7, true, false]);

		const older = await messageWindow(id, '?limit=3&before=5');
		expect(positions(older)).toEqual([2, 4, true, true]);
		expect(JSON.stringify(older.messages[0]?.parts)).toContain('dos');

		const oldest = await messageWindow(id, '?limit=3&before=2');
		expect(positions(oldest)).toEqual([1, 1, false, true]);

		const newer = await messageWindow(id, '?limit=10&after=5');
		expect(positions(newer)).toEqual([6, 7, true, false]);

		const middle = await messageWindow(id, '?limit=1&after=3');
		expect(positions(middle)).toEqual([4, 4, true, true]);
	});

	/**
	 * Positions start at 1, so `after=0` names no message: it means "after the
	 * start of the thread". It is how the screen jumps to the beginning of a
	 * long conversation without walking every page backwards to find it.
	 */
	test('after=0 is the oldest page', async () => {
		const id = await createThread();
		await seedMessages(id, texts);

		const beginning = await messageWindow(id, '?limit=3&after=0');
		expect(positions(beginning)).toEqual([1, 3, false, true]);
		expect(JSON.stringify(beginning.messages[0]?.parts)).toContain(texts[0]);

		// A negative cursor is still nonsense, and stays a 422.
		const response = await request(
			`/agent/threads/${id}/messages?limit=3&after=-1`,
		);
		expect(response.status).toBe(422);
	});

	/**
	 * An empty page has no row to read an edge from, so the answer comes from
	 * the cursor it was asked with: past either end of the thread, everything
	 * the client does not hold is on the other side of that cursor.
	 */
	test('an empty page reports the side its cursor came from', async () => {
		const id = await createThread();
		await seedMessages(id, texts);

		expect(positions(await messageWindow(id, '?limit=3&before=1'))).toEqual([
			null,
			null,
			false,
			true,
		]);
		expect(
			positions(await messageWindow(id, `?limit=3&after=${texts.length}`)),
		).toEqual([null, null, true, false]);
	});

	test('a window is always ascending, whichever way it was asked for', async () => {
		const id = await createThread();
		await seedMessages(id, texts);
		for (const search of [
			'?limit=3',
			'?limit=3&before=6',
			'?limit=3&after=1',
		]) {
			const window = await messageWindow(id, search);
			const seen = window.messages.map(
				(message) => (message.parts[0] as { text: string }).text,
			);
			expect(seen).toEqual(
				[...seen].sort((a, b) => texts.indexOf(a) - texts.indexOf(b)),
			);
		}
	});

	test('both cursors at once is a 422', async () => {
		const id = await createThread();
		const response = await request(
			`/agent/threads/${id}/messages?before=4&after=2`,
		);
		expect(response.status).toBe(422);
		expect(((await response.json()) as { error: string }).error).toBe(
			'AGENT_CURSOR_CONFLICT',
		);
	});

	test('404s for a thread that does not exist', async () => {
		const response = await request(
			`/agent/threads/${Bun.randomUUIDv7()}/messages?limit=5`,
		);
		expect(response.status).toBe(404);
	});
});

describe('agent thread search', () => {
	type Match = {
		id: string;
		position: number;
		role: string;
		snippet: string;
	};

	async function search(threadId: string, query: string) {
		const response = await request(
			`/agent/threads/${threadId}/search?query=${query}`,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			matches: Match[];
			nextCursor: number | null;
		};
	}

	test('matches text parts, never the shape of the jsonb', async () => {
		const id = await createThread();
		await db.insert(agentMessage).values([
			// Its jsonb literally contains "type" — as a key, which must not match.
			{
				id: Bun.randomUUIDv7(),
				threadId: id,
				position: 1,
				role: 'user',
				parts: [{ type: 'text' as const, text: 'hola mundo' }],
			},
			{
				id: Bun.randomUUIDv7(),
				threadId: id,
				position: 2,
				role: 'assistant',
				parts: [{ type: 'text' as const, text: 'el campo type es raro' }],
			},
			// A reasoning part carries text too, and is not what the finder reads.
			{
				id: Bun.randomUUIDv7(),
				threadId: id,
				position: 3,
				role: 'assistant',
				parts: [{ type: 'reasoning' as const, text: 'pensando en type' }],
			},
		]);

		const { matches } = await search(id, 'type');
		expect(matches.map((match) => match.position)).toEqual([2]);
		expect(matches[0]?.role).toBe('assistant');
		expect(matches[0]?.snippet).toContain('type');
	});

	test('answers newest first and needs a query', async () => {
		const id = await createThread();
		await seedMessages(id, [
			'buscame uno',
			'nada',
			'buscame dos',
			'buscame tres',
		]);

		const { matches } = await search(id, 'buscame');
		expect(matches.map((match) => match.position)).toEqual([4, 3, 1]);

		const limited = await request(
			`/agent/threads/${id}/search?query=buscame&limit=2`,
		);
		expect(
			((await limited.json()) as { matches: unknown[] }).matches,
		).toHaveLength(2);

		expect((await request(`/agent/threads/${id}/search`)).status).toBe(422);
		expect(
			(await request(`/agent/threads/${id}/search?query=%20`)).status,
		).toBe(422);
		expect(
			(await request(`/agent/threads/${Bun.randomUUIDv7()}/search?query=x`))
				.status,
		).toBe(404);
	});

	test('escapes the LIKE metacharacters of the query', async () => {
		const id = await createThread();
		// The decoys are what an unescaped wildcard would return alongside.
		await seedMessages(id, [
			'el archivo plan_a quedó',
			'el archivo planXa quedó',
			'subió 100% en el mes',
			'subió 100 y algo en el mes',
		]);

		expect((await search(id, 'plan_a')).matches.map((m) => m.position)).toEqual(
			[1],
		);
		expect((await search(id, '100%25')).matches.map((m) => m.position)).toEqual(
			[3],
		);
		expect((await search(id, 'plana')).matches).toEqual([]);
	});

	test('continues a truncated search with a position cursor', async () => {
		const id = await createThread();
		await seedMessages(id, ['hit uno', 'hit dos', 'hit tres', 'hit cuatro']);

		const firstResponse = await request(
			`/agent/threads/${id}/search?query=hit&limit=2`,
		);
		const first = (await firstResponse.json()) as {
			matches: Match[];
			nextCursor: number | null;
		};
		expect(first.matches.map((match) => match.position)).toEqual([4, 3]);
		expect(first.nextCursor).toBe(3);

		const secondResponse = await request(
			`/agent/threads/${id}/search?query=hit&limit=2&before=${first.nextCursor}`,
		);
		const second = (await secondResponse.json()) as {
			matches: Match[];
			nextCursor: number | null;
		};
		expect(second.matches.map((match) => match.position)).toEqual([2, 1]);
		expect(second.nextCursor).toBeNull();
	});
});

describe('buildSnippet', () => {
	const long = `${'a'.repeat(200)} aguja ${'b'.repeat(200)}`;

	test('returns a short text untouched', () => {
		expect(buildSnippet('hola mundo', 'mundo')).toBe('hola mundo');
	});

	test('crops around the first match and marks both cuts', () => {
		const snippet = buildSnippet(long, 'aguja');
		expect(snippet).toContain('aguja');
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(SNIPPET_RADIUS * 2 + 20);
	});

	test('does not mark a cut that did not happen', () => {
		const head = buildSnippet(`aguja ${'b'.repeat(200)}`, 'aguja');
		expect(head.startsWith('…')).toBe(false);
		expect(head.endsWith('…')).toBe(true);

		const tail = buildSnippet(`${'a'.repeat(200)} aguja`, 'aguja');
		expect(tail.startsWith('…')).toBe(true);
		expect(tail.endsWith('…')).toBe(false);
	});

	test('matches case-insensitively, like the query that produced it', () => {
		expect(buildSnippet(long, 'AGUJA')).toContain('aguja');
	});

	test('falls back to the head when the query is not in this text', () => {
		const snippet = buildSnippet(long, 'inexistente');
		expect(snippet.startsWith('a')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
	});
});

describe('agent index cache', () => {
	const mutations: {
		name: string;
		run: (threadId: string) => Promise<void>;
	}[] = [
		{
			name: 'POST /agent/threads',
			run: async () => {
				await createThread();
			},
		},
		{
			name: 'PATCH /agent/threads/:id',
			run: async (threadId) => {
				await json(`/agent/threads/${threadId}`, 'PATCH', { title: 'Nuevo' });
			},
		},
		{
			name: 'POST /agent/threads/:id/title',
			run: async (threadId) => {
				await seedMessages(threadId, ['Tema del título']);
				modelOverride.resolve = () =>
					new MockLanguageModelV4({
						doGenerate: [generated('Título regenerado')],
					});
				await json(`/agent/threads/${threadId}/title`, 'POST', {
					model: 'claude-sonnet-5',
				});
			},
		},
		{
			name: 'POST /agent/threads/bulk/delete',
			run: async (threadId) => {
				await json('/agent/threads/bulk/delete', 'POST', { ids: [threadId] });
			},
		},
		{
			name: 'DELETE /agent/threads/:id',
			run: async (threadId) => {
				await request(`/agent/threads/${threadId}`, { method: 'DELETE' });
			},
		},
		{
			name: 'POST /agent/chat',
			run: async (threadId) => {
				useMockModel([textResult('invalida el índice')]);
				await (
					await json('/agent/chat', 'POST', chatBody(threadId, 'hola'))
				).text();
				await waitFor(
					() => threadRows(threadId),
					(rows) => rows.length === 2,
				);
			},
		},
	];

	for (const { name, run } of mutations)
		test(`${name} invalidates the index tag`, async () => {
			const threadId = await createThread();
			const first = await request('/agent/threads');
			const tag = first.headers.get('etag') ?? '';
			expect(tag).not.toBe('');

			const unchanged = await request('/agent/threads', {
				headers: { 'if-none-match': tag },
			});
			expect(unchanged.status).toBe(304);

			await run(threadId);

			const after = await waitFor(
				() => request('/agent/threads', { headers: { 'if-none-match': tag } }),
				(response) => response.status === 200,
			);
			expect(after.status).toBe(200);
		});
});

/** doGenerate answers for the mock: one non-stream completion with this text. */
function generated(text: string) {
	return {
		content: [{ type: 'text' as const, text }],
		finishReason: { unified: 'stop' as const, raw: undefined },
		usage,
		warnings: [],
	};
}

describe('agent settings', () => {
	test('round-trips every global next-turn choice', async () => {
		const settings = {
			selection: {
				model: 'deepseek/deepseek-v4-pro-0813',
				reasoning: 'off',
				tools: ['tavily'],
				maxSteps: AGENT_MAX_STEPS,
				temperature: 0.4,
			},
			titleModel: 'claude-haiku-4-5',
			compactionModel: 'gpt-5.6-luna',
		};
		const put = await json('/agent/settings', 'PUT', {
			...settings,
		});
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({ settings });

		const got = await request('/agent/settings');
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual({ settings });
	});

	test('keeps old title-only cached settings readable', async () => {
		await cache.set(AGENT_SETTINGS_KEY, { titleModel: 'retired-model' });

		const got = await request('/agent/settings');
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual({
			settings: { titleModel: 'retired-model' },
		});
	});

	test('treats unknown-only cached settings as unreadable', async () => {
		await cache.set(AGENT_SETTINGS_KEY, { titleModell: 'typo' });

		const got = await request('/agent/settings');
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual({ settings: null });
	});

	test('keeps structurally valid retired selection ids readable', async () => {
		const settings = {
			selection: {
				model: 'retired-model',
				reasoning: 'retired-level',
				tools: ['retired-tool'],
				maxSteps: AGENT_MAX_STEPS,
				temperature: 99,
			},
		};
		await cache.set(AGENT_SETTINGS_KEY, settings);

		const got = await request('/agent/settings');
		expect(await got.json()).toEqual({ settings });
	});

	test('an empty settings clears the choices', async () => {
		await json('/agent/settings', 'PUT', { titleModel: 'claude-haiku-4-5' });
		const cleared = await json('/agent/settings', 'PUT', {});
		expect(cleared.status).toBe(200);
		const got = await request('/agent/settings');
		expect(await got.json()).toEqual({ settings: {} });
	});

	test('rejects an unknown top-level field without replacing settings', async () => {
		const stored = { titleModel: 'claude-haiku-4-5' };
		await cache.set(AGENT_SETTINGS_KEY, stored);

		const response = await json('/agent/settings', 'PUT', {
			titleModell: 'gpt-5.6-luna',
		});
		expect(response.status).toBe(422);
		const got = await request('/agent/settings');
		expect(await got.json()).toEqual({ settings: stored });
	});

	test('rejects an unknown selection field without replacing settings', async () => {
		const stored = { titleModel: 'claude-haiku-4-5' };
		await cache.set(AGENT_SETTINGS_KEY, stored);

		const response = await json('/agent/settings', 'PUT', {
			selection: {
				model: 'claude-sonnet-5',
				reasoning: 'low',
				tools: [],
				maxSteps: 5,
				unknown: true,
			},
		});
		expect(response.status).toBe(422);
		const got = await request('/agent/settings');
		expect(await got.json()).toEqual({ settings: stored });
	});

	test('a model the registry does not know is a 422', async () => {
		const response = await json('/agent/settings', 'PUT', {
			titleModel: 'made-up-model',
		});
		expect(response.status).toBe(422);
	});

	test('rejects invalid current selection combinations', async () => {
		const selection = {
			model: 'deepseek/deepseek-v4-pro-0813',
			reasoning: 'off',
			tools: ['tavily'],
			maxSteps: 5,
			temperature: 0.4,
		};
		for (const [override, error] of [
			[{ model: 'made-up-model' }, 'AGENT_MODEL_UNKNOWN'],
			[{ reasoning: 'medium' }, 'AGENT_REASONING_UNKNOWN'],
			[{ tools: ['made-up-tool'] }, 'AGENT_TOOL_UNKNOWN'],
			[{ temperature: 0.05 }, 'AGENT_TEMPERATURE_UNSUPPORTED'],
			[{ maxSteps: 0 }, undefined],
			[{ maxSteps: 1.5 }, undefined],
			[{ maxSteps: AGENT_MAX_STEPS + 1 }, undefined],
		] as const) {
			const response = await json('/agent/settings', 'PUT', {
				selection: { ...selection, ...override },
			});
			expect(response.status).toBe(422);
			if (error !== undefined) expect(await response.json()).toEqual({ error });
		}
	});

	test('treats structurally invalid cached selections as unreadable', async () => {
		for (const selection of [
			{ model: 'retired', tools: [], maxSteps: 0 },
			{ model: 'retired', tools: [], maxSteps: AGENT_MAX_STEPS + 1 },
			{ model: 'retired', tools: [], maxSteps: 1, temperature: Infinity },
		]) {
			await cache.set(AGENT_SETTINGS_KEY, { selection });
			const got = await request('/agent/settings');
			expect(await got.json()).toEqual({ settings: null });
		}
	});

	test('reports an unavailable settings write instead of claiming success', async () => {
		const original = agentSettingsStore.write;
		agentSettingsStore.write = mock(async () => false);
		try {
			const response = await json('/agent/settings', 'PUT', {
				titleModel: 'claude-haiku-4-5',
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: 'AGENT_SETTINGS_UNAVAILABLE',
			});
		} finally {
			agentSettingsStore.write = original;
		}
	});
});

describe('agent thread fork', () => {
	async function seededThread() {
		const id = await createThread();
		useMockModel([textResult('primera respuesta'), textResult('segunda')]);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'pregunta uno'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'pregunta dos'))
		).text();
		const rows = await waitFor(
			() => threadRows(id),
			(found) => found.length === 4,
		);
		return { id, rows };
	}

	test('copies everything up to the chosen reply into a new thread', async () => {
		const { id, rows } = await seededThread();
		const firstReply = rows[1];
		if (!firstReply) throw new Error('seed did not persist');

		const response = await json(`/agent/threads/${id}/fork`, 'POST', {
			messageId: firstReply.id,
		});
		expect(response.status).toBe(201);
		const forked = (await response.json()) as { id: string; title: string };
		createdThreadIds.add(forked.id);

		const copies = await threadRows(forked.id);
		expect(copies.map((row) => row.position)).toEqual([1, 2]);
		expect(copies.map((row) => row.role)).toEqual(['user', 'assistant']);
		// The copies are new rows, not shared ones: forked turns diverge freely.
		const originalIds = new Set(rows.map((row) => row.id));
		for (const copy of copies) expect(originalIds.has(copy.id)).toBe(false);
		expect(JSON.stringify(copies[1]?.parts)).toContain('primera respuesta');
		// The stats of the copied turn survive the copy.
		expect(copies[1]?.metadata).toEqual(firstReply.metadata);
		const [sourceThread, forkedThread] = await Promise.all([
			db.select().from(agentThread).where(eq(agentThread.id, id)).limit(1),
			db
				.select()
				.from(agentThread)
				.where(eq(agentThread.id, forked.id))
				.limit(1),
		]);
		expect(forkedThread[0]?.titleAuto).toBe(sourceThread[0]?.titleAuto);
		expect(forkedThread[0]?.incarnation).not.toBe(sourceThread[0]?.incarnation);

		// The source thread is untouched.
		expect(await threadRows(id)).toHaveLength(4);
	});

	test('only an assistant message is a fork point', async () => {
		const { id, rows } = await seededThread();
		const userTurn = rows[0];
		if (!userTurn) throw new Error('seed did not persist');

		const fromUser = await json(`/agent/threads/${id}/fork`, 'POST', {
			messageId: userTurn.id,
		});
		expect(fromUser.status).toBe(422);

		const stranger = await json(`/agent/threads/${id}/fork`, 'POST', {
			messageId: Bun.randomUUIDv7(),
		});
		expect(stranger.status).toBe(422);

		const noThread = await json(
			`/agent/threads/${Bun.randomUUIDv7()}/fork`,
			'POST',
			{ messageId: userTurn.id },
		);
		expect(noThread.status).toBe(404);
	});

	test('preserves manual title ownership through first-turn regenerate', async () => {
		const { id, rows } = await seededThread();
		const firstReply = rows[1];
		if (!firstReply) throw new Error('seed did not persist');
		await json(`/agent/threads/${id}`, 'PATCH', { title: 'Título manual' });
		const response = await json(`/agent/threads/${id}/fork`, 'POST', {
			messageId: firstReply.id,
		});
		const forked = (await response.json()) as { id: string };
		createdThreadIds.add(forked.id);
		const copied = await threadRows(forked.id);
		const firstUser = copied[0];
		if (!firstUser) throw new Error('fork did not copy first user turn');
		useMockModel([textResult('respuesta regenerada')]);

		await (
			await json('/agent/chat', 'POST', {
				...chatBody(forked.id, 'pregunta uno'),
				message: {
					id: firstUser.id,
					role: 'user',
					parts: firstUser.parts,
				},
			})
		).text();
		await waitFor(
			() => threadRows(forked.id),
			(found) =>
				found.length === 2 &&
				JSON.stringify(found[1]?.parts).includes('regenerada'),
		);
		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, forked.id));
		expect(thread?.title).toBe('Título manual');
		expect(thread?.titleAuto).toBe(false);
	});
});

describe('agent thread titles', () => {
	test('explicitly regenerates a title from bounded visible conversation text', async () => {
		await json('/agent/settings', 'PUT', { titleModel: 'claude-haiku-4-5' });
		const id = await createThread();
		await db.insert(agentMessage).values([
			{
				id: Bun.randomUUIDv7(),
				threadId: id,
				position: 1,
				role: 'user',
				parts: [{ type: 'text', text: `Visible topic ${'x'.repeat(20_000)}` }],
			},
			{
				id: Bun.randomUUIDv7(),
				threadId: id,
				position: 2,
				role: 'assistant',
				parts: [
					{ type: 'reasoning', text: 'HIDDEN_REASONING' },
					{
						type: 'tool-tavily',
						toolCallId: 'secret-call',
						state: 'input-available',
						input: { query: 'HIDDEN_TOOL_PAYLOAD' },
					},
					{ type: 'text', text: 'Visible answer' },
				],
			},
		]);
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: [generated('  "Nuevo título explícito"  ')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};

		const response = await json(`/agent/threads/${id}/title`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toMatchObject({
			id,
			title: 'Nuevo título explícito',
		});
		expect(resolved).toEqual(['claude-haiku-4-5']);
		const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
		expect(prompt).toContain('Visible topic');
		expect(prompt.length).toBeLessThan(15_000);
		expect(prompt).not.toContain('HIDDEN_REASONING');
		expect(prompt).not.toContain('HIDDEN_TOOL_PAYLOAD');
		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(thread?.titleAuto).toBe(false);
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });
	});

	test('retitle uses the request fallback and reports missing model, thread, and history', async () => {
		const id = await createThread();
		await seedMessages(id, ['Fallback title subject']);
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: [generated('Fallback title')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};
		const fallback = await json(`/agent/threads/${id}/title`, 'POST', {
			model: 'gpt-5.6-luna',
		});
		expect(fallback.status).toBe(200);
		expect(resolved).toEqual(['gpt-5.6-luna']);

		const noModel = await json(`/agent/threads/${id}/title`, 'POST', {});
		expect(noModel.status).toBe(422);
		expect(await noModel.json()).toEqual({
			error: 'AGENT_TITLE_MODEL_MISSING',
		});

		const empty = await createThread();
		const noHistory = await json(`/agent/threads/${empty}/title`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(noHistory.status).toBe(422);
		expect(await noHistory.json()).toEqual({ error: 'AGENT_TITLE_EMPTY' });

		const missing = await json(
			`/agent/threads/${Bun.randomUUIDv7()}/title`,
			'POST',
			{ model: 'claude-sonnet-5' },
		);
		expect(missing.status).toBe(404);
	});

	test('retitle claims the mutation lease and releases it after provider failure', async () => {
		const id = await createThread();
		await seedMessages(id, ['Lease title subject']);
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error('title provider failed');
			},
		});
		modelOverride.resolve = () => model;
		const failed = await json(`/agent/threads/${id}/title`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({ error: 'AGENT_TITLE_FAILED' });
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });

		await db
			.update(agentThread)
			.set({
				mutationOwner: Bun.randomUUIDv7(),
				mutationExpiresAt: new Date(Date.now() + 60_000),
			})
			.where(eq(agentThread.id, id));
		const calls = model.doGenerateCalls.length;
		const busy = await json(`/agent/threads/${id}/title`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(busy.status).toBe(409);
		expect(await busy.json()).toEqual({ error: 'AGENT_THREAD_BUSY' });
		expect(model.doGenerateCalls).toHaveLength(calls);
	});

	test('a manual rename cannot race an explicit retitle lease', async () => {
		const id = await createThread();
		await seedMessages(id, ['Race title subject']);
		let releaseTitle: (() => void) | undefined;
		const titleGate = new Promise<void>((resolve) => {
			releaseTitle = resolve;
		});
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				await titleGate;
				return generated('Generated winner');
			},
		});
		modelOverride.resolve = () => model;

		const retitling = json(`/agent/threads/${id}/title`, 'POST', {
			model: 'claude-sonnet-5',
		});
		await waitFor(
			() => Promise.resolve(model.doGenerateCalls.length),
			(calls) => calls === 1,
		);
		const rename = await json(`/agent/threads/${id}`, 'PATCH', {
			title: 'Manual loser',
		});
		expect(rename.status).toBe(409);
		expect(await rename.json()).toEqual({ error: 'AGENT_THREAD_BUSY' });

		releaseTitle?.();
		const retitled = await retitling;
		expect(retitled.status).toBe(200);
		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(thread?.title).toBe('Generated winner');
		expect(thread?.titleAuto).toBe(false);
	});

	test('manual rename reclaims an expired mutation lease', async () => {
		const id = await createThread();
		await db
			.update(agentThread)
			.set({
				mutationOwner: Bun.randomUUIDv7(),
				mutationExpiresAt: new Date(Date.now() - 1_000),
			})
			.where(eq(agentThread.id, id));

		const renamed = await json(`/agent/threads/${id}`, 'PATCH', {
			title: 'Recovered rename',
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ title: 'Recovered rename' });
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });
	});

	test('the first exchange titles the thread with the cached model', async () => {
		await json('/agent/settings', 'PUT', { titleModel: 'claude-haiku-4-5' });
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doStream: [textResult('hola')],
			doGenerate: [generated('  "Plan del viaje a Japón"  ')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};

		const id = await createThread();
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'Ayudame con mi viaje'))
		).text();

		const [thread] = await waitFor(
			() =>
				db.select().from(agentThread).where(eq(agentThread.id, id)).limit(1),
			(found) => found[0]?.title === 'Plan del viaje a Japón',
		);
		expect(thread?.title).toBe('Plan del viaje a Japón');
		expect(resolved).toContain('claude-haiku-4-5');
	});

	test('a failing title generation keeps the derived title', async () => {
		// No doGenerate: the title call throws, the fallback already stands.
		useMockModel([textResult('hola')]);
		const id = await createThread();
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'Primer mensaje largo'))
		).text();

		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id))
			.limit(1);
		expect(thread?.title).toBe('Primer mensaje largo');
	});

	test('an unknown cached model falls back to the requested one', async () => {
		await cache.set(AGENT_SETTINGS_KEY, { titleModel: 'retired-model' });
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doStream: [textResult('hola')],
			doGenerate: [generated('Título del fallback')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};

		const id = await createThread();
		await (await json('/agent/chat', 'POST', chatBody(id, 'hola'))).text();

		await waitFor(
			() =>
				db.select().from(agentThread).where(eq(agentThread.id, id)).limit(1),
			(found) => found[0]?.title === 'Título del fallback',
		);
		// The stranger never reached the resolver; the request's model titled it.
		expect(resolved).not.toContain('retired-model');
		expect(resolved.filter((id) => id === 'claude-sonnet-5')).not.toHaveLength(
			0,
		);
	});

	test('title generation does not hold the stream open or overwrite a rename', async () => {
		let releaseTitle: (() => void) | undefined;
		const titleGate = new Promise<void>((resolve) => {
			releaseTitle = resolve;
		});
		const model = new MockLanguageModelV4({
			doStream: [textResult('hola')],
			doGenerate: async () => {
				await titleGate;
				return generated('Título tardío');
			},
		});
		modelOverride.resolve = () => model;
		const id = await createThread();
		const response = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'Título derivado'),
		);
		const body = response.text();
		const closed = await Promise.race([
			body.then(() => true),
			Bun.sleep(100).then(() => false),
		]);
		if (closed)
			await json(`/agent/threads/${id}`, 'PATCH', { title: 'Título derivado' });
		releaseTitle?.();
		await body;
		expect(closed).toBe(true);
		await Bun.sleep(50);

		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id))
			.limit(1);
		expect(thread?.title).toBe('Título derivado');
	});

	test('a detached title cannot update a recreated thread with the same id', async () => {
		let releaseTitle: (() => void) | undefined;
		const titleGate = new Promise<void>((resolve) => {
			releaseTitle = resolve;
		});
		const model = new MockLanguageModelV4({
			doStream: [textResult('old reply')],
			doGenerate: async () => {
				await titleGate;
				return generated('Título de otra encarnación');
			},
		});
		modelOverride.resolve = () => model;
		const id = await createThread();
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'Mismo derivado'))
		).text();
		await request(`/agent/threads/${id}`, { method: 'DELETE' });
		await createThread(id);
		await db
			.update(agentThread)
			.set({ title: 'Mismo derivado', revision: 1 })
			.where(eq(agentThread.id, id));
		releaseTitle?.();
		await Bun.sleep(50);

		const [thread] = await db
			.select()
			.from(agentThread)
			.where(eq(agentThread.id, id));
		expect(thread?.title).toBe('Mismo derivado');
	});
});

describe('agent compaction', () => {
	async function seededThread() {
		const id = await createThread();
		useMockModel([textResult('respuesta vieja')]);
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'tema viejo'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 2,
		);
		return id;
	}

	test('compacts with the cached model and stores the marker', async () => {
		await json('/agent/settings', 'PUT', { compactionModel: 'gpt-5.6-luna' });
		// Seed first: the helper installs its own doStream-only mock.
		const id = await seededThread();
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: [generated('Resumen: hablamos del tema viejo.')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};

		const response = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(response.status).toBe(201);

		const rows = await threadRows(id);
		expect(rows).toHaveLength(3);
		const marker = rows[2];
		expect(marker?.role).toBe('assistant');
		expect(marker?.metadata).toMatchObject({
			kind: 'compaction',
			model: 'gpt-5.6-luna',
		});
		expect(JSON.stringify(marker?.parts)).toContain('tema viejo');
		expect(resolved).toContain('gpt-5.6-luna');
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });
	});

	test('a failed compaction releases its lease for an immediate retry', async () => {
		const id = await seededThread();
		let call = 0;
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				call += 1;
				if (call === 1) throw new Error('generation failed');
				return generated('Resumen recuperado');
			},
		});
		modelOverride.resolve = () => model;

		const failed = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(failed.status).toBe(502);
		const retry = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(retry.status).toBe(201);
		expect(await mutationState(id)).toEqual({ owner: null, expiresAt: null });
	});

	test('falls back to the model the UI sent when nothing is cached', async () => {
		const id = await seededThread();
		const resolved: string[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: [generated('Resumen corto.')],
		});
		modelOverride.resolve = (entry) => {
			resolved.push(entry.id);
			return model;
		};

		const response = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(response.status).toBe(201);
		expect(resolved).toContain('claude-sonnet-5');
	});

	test('an empty thread and a missing model are 422s', async () => {
		const empty = await createThread();
		const noMessages = await json(`/agent/threads/${empty}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(noMessages.status).toBe(422);

		const id = await seededThread();
		const noModel = await json(`/agent/threads/${id}/compact`, 'POST', {});
		expect(noModel.status).toBe(422);
	});

	test('returns 404 when the thread to compact does not exist', async () => {
		const response = await json(
			`/agent/threads/${Bun.randomUUIDv7()}/compact`,
			'POST',
			{ model: 'claude-sonnet-5' },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'AGENT_THREAD_NOT_FOUND' });
	});

	test('the next turn reads the compaction plus the exchanges it can carry', async () => {
		const id = await seededThread();
		useMockModel([
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start' as const, warnings: [] },
						{ type: 'text-start' as const, id: 'text-1' },
						{ type: 'text-delta' as const, id: 'text-1', delta: 'ok' },
						{ type: 'text-end' as const, id: 'text-1' },
						{
							type: 'finish' as const,
							finishReason: { unified: 'stop' as const, raw: undefined },
							usage,
						},
					],
				}),
			},
		]);
		// A compaction marker as the compact endpoint stores it.
		await db.insert(agentMessage).values({
			id: Bun.randomUUIDv7(),
			threadId: id,
			position: 3,
			role: 'assistant',
			parts: [{ type: 'text', text: 'RESUMEN DEL PASADO' }],
			metadata: { kind: 'compaction', model: 'claude-sonnet-5' },
		});
		await cache.del(threadMessagesKey(id));

		const model = new MockLanguageModelV4({
			doStream: [textResult('sigo desde el resumen')],
		});
		modelOverride.resolve = () => model;
		await (
			await json('/agent/chat', 'POST', chatBody(id, 'tema nuevo'))
		).text();
		await waitFor(
			() => threadRows(id),
			(rows) => rows.length === 5,
		);

		const [call] = model.doStreamCalls;
		const wire = JSON.stringify(call?.prompt);
		// The summary, the new turn, and — within the budget — the raw exchange
		// the summary replaced, so a follow-up about it still resolves.
		expect(wire).toContain('RESUMEN DEL PASADO');
		expect(wire).toContain('tema nuevo');
		expect(wire).toContain('tema viejo');
		// Persistence still appends to the full thread, positions intact.
		const rows = await threadRows(id);
		expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5]);
	});

	/**
	 * A thread whose substance was tool work summarized from the assistant's
	 * prose about it only, because the transcript kept text parts and dropped
	 * everything else. The searches and their results were the context.
	 */
	test('the summary sees tool work, not just the prose around it', async () => {
		const id = await seededThread();
		await db.insert(agentMessage).values({
			id: Bun.randomUUIDv7(),
			threadId: id,
			position: 3,
			role: 'assistant',
			parts: [
				{ type: 'text', text: 'busqué eso' },
				{
					type: 'tool-tavily',
					toolCallId: 'call-1',
					state: 'output-available',
					input: { query: 'precio del dolar' },
					output: { results: [{ title: 'Cotización de hoy' }] },
				},
			],
		});
		await cache.del(threadMessagesKey(id));

		const model = new MockLanguageModelV4({
			doGenerate: [generated('RESUMEN')],
		});
		modelOverride.resolve = () => model;

		const response = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(response.status).toBe(201);

		const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
		expect(prompt).toContain('tavily');
		expect(prompt).toContain('precio del dolar');
		expect(prompt).toContain('Cotización de hoy');
	});

	/**
	 * The asymmetry that keeps repeated compactions cheap: a turn carries raw
	 * turns forward, a re-compaction never does. Without it each summary would
	 * re-read the tail the previous one already replaced.
	 */
	test('a second compaction summarizes only from the previous marker', async () => {
		const id = await seededThread();
		await db.insert(agentMessage).values({
			id: Bun.randomUUIDv7(),
			threadId: id,
			position: 3,
			role: 'assistant',
			parts: [{ type: 'text', text: 'RESUMEN PREVIO' }],
			metadata: { kind: 'compaction', model: 'claude-sonnet-5' },
		});
		await db.insert(agentMessage).values({
			id: Bun.randomUUIDv7(),
			threadId: id,
			position: 4,
			role: 'user',
			parts: [{ type: 'text', text: 'tema posterior' }],
		});
		await cache.del(threadMessagesKey(id));

		const model = new MockLanguageModelV4({
			doGenerate: [generated('RESUMEN NUEVO')],
		});
		modelOverride.resolve = () => model;

		const response = await json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		expect(response.status).toBe(201);

		const [call] = model.doGenerateCalls;
		const prompt = JSON.stringify(call?.prompt);
		expect(prompt).toContain('RESUMEN PREVIO');
		expect(prompt).toContain('tema posterior');
		expect(prompt).not.toContain('tema viejo');
	});

	test('a compaction lease rejects chat before starting its provider', async () => {
		const id = await seededThread();
		let releaseSummary: (() => void) | undefined;
		const summaryGate = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				await summaryGate;
				return generated('Resumen obsoleto');
			},
		});
		modelOverride.resolve = () => model;

		const compacting = json(`/agent/threads/${id}/compact`, 'POST', {
			model: 'claude-sonnet-5',
		});
		await waitFor(
			() => Promise.resolve(model.doGenerateCalls.length),
			(count) => count === 1,
		);
		const chat = await json(
			'/agent/chat',
			'POST',
			chatBody(id, 'nuevo mientras resume'),
		);
		expect(chat.status).toBe(409);
		expect(await chat.json()).toEqual({ error: 'AGENT_THREAD_BUSY' });
		expect(model.doStreamCalls).toHaveLength(0);
		releaseSummary?.();

		const response = await compacting;
		expect(response.status).toBe(201);
		const rows = await threadRows(id);
		expect(rows).toHaveLength(3);
		expect(rows[2]?.metadata?.kind).toBe('compaction');
	});
});

describe('compactionWindow', () => {
	const message = (id: string, kind?: 'compaction') => ({
		id,
		role: 'assistant' as const,
		parts: [],
		...(kind ? { metadata: { kind } } : {}),
	});

	test('slices from the last marker and passes untouched histories through', () => {
		const plain = [message('a'), message('b')];
		expect(compactionWindow(plain)).toEqual(plain);

		const compacted = [
			message('a'),
			message('viejo-marker', 'compaction'),
			message('c'),
			message('nuevo-marker', 'compaction'),
			message('e'),
		];
		expect(compactionWindow(compacted).map((m) => m.id)).toEqual([
			'nuevo-marker',
			'e',
		]);
	});

	test('ignores a compaction marker on a user message', () => {
		const messages = [
			message('before'),
			{
				id: 'forged',
				role: 'user' as const,
				parts: [],
				metadata: { kind: 'compaction' as const, model: 'forged' },
			},
			message('after'),
		];
		expect(compactionWindow(messages)).toEqual(messages);
	});
});

/**
 * What a turn sends is not what a re-compaction summarizes. The summary is the
 * memory of the turns it replaced, but a follow-up like "and the second one?"
 * resolves against the words that were actually on screen, so a bounded tail of
 * raw exchanges rides along with it.
 */
describe('promptWindow', () => {
	const text = (id: string, role: 'user' | 'assistant', body: string) => ({
		id,
		role,
		parts: [{ type: 'text' as const, text: body }],
	});
	const marker = (id: string) => ({
		id,
		role: 'assistant' as const,
		parts: [{ type: 'text' as const, text: 'brief' }],
		metadata: { kind: 'compaction' as const, model: 'test' },
	});

	test('passes a history with no marker through untouched', () => {
		const plain = [text('a', 'user', 'hola'), text('b', 'assistant', 'chau')];
		expect(promptWindow(plain)).toEqual(plain);
	});

	test('carries whole exchanges before the marker', () => {
		const messages = [
			text('u1', 'user', 'primera'),
			text('a1', 'assistant', 'respuesta uno'),
			text('u2', 'user', 'segunda'),
			text('a2', 'assistant', 'respuesta dos'),
			marker('m'),
			text('u3', 'user', 'nueva'),
		];

		expect(promptWindow(messages).map((message) => message.id)).toEqual([
			'u1',
			'a1',
			'u2',
			'a2',
			'm',
			'u3',
		]);
	});

	test('stops at an exchange boundary instead of mid-exchange', () => {
		// The oldest exchange alone overruns the budget, so it is dropped whole:
		// a boundary inside one could hand the provider a tool result whose call
		// was left behind.
		const huge = 'x'.repeat(CARRIED_CONTEXT_BUDGET_CHARS);
		const messages = [
			text('u1', 'user', 'vieja'),
			text('a1', 'assistant', huge),
			text('u2', 'user', 'reciente'),
			text('a2', 'assistant', 'corta'),
			marker('m'),
		];

		expect(promptWindow(messages).map((message) => message.id)).toEqual([
			'u2',
			'a2',
			'm',
		]);
	});

	test('never crosses the budget, even for one enormous exchange', () => {
		const huge = 'y'.repeat(CARRIED_CONTEXT_BUDGET_CHARS * 2);
		const messages = [
			text('u1', 'user', 'pregunta'),
			text('a1', 'assistant', huge),
			marker('m'),
			text('u2', 'user', 'sigo'),
		];

		expect(promptWindow(messages).map((message) => message.id)).toEqual([
			'm',
			'u2',
		]);
	});

	test('counts tool parts, not just the text a message shows', () => {
		const bulky = {
			id: 'a1',
			role: 'assistant' as const,
			parts: [
				{ type: 'text' as const, text: 'listo' },
				{
					type: 'tool-tavily' as const,
					toolCallId: 'call-1',
					state: 'output-available' as const,
					input: { query: 'q' },
					output: { blob: 'z'.repeat(CARRIED_CONTEXT_BUDGET_CHARS) },
				},
			],
		} as unknown as UIMessage;
		const messages = [
			text('u1', 'user', 'buscá'),
			bulky,
			text('u2', 'user', 'gracias'),
			text('a2', 'assistant', 'de nada'),
			marker('m'),
		];

		// Measured on what actually travels: the tool output is the payload here,
		// and a text-only count would have carried it as if it were free.
		expect(promptWindow(messages).map((message) => message.id)).toEqual([
			'u2',
			'a2',
			'm',
		]);
	});

	test('carries nothing when the marker opens the thread', () => {
		const messages = [marker('m'), text('u1', 'user', 'hola')];
		expect(promptWindow(messages).map((message) => message.id)).toEqual([
			'm',
			'u1',
		]);
	});

	test('reads from the newest marker, not an older one', () => {
		const messages = [
			text('u1', 'user', 'antiguo'),
			marker('m1'),
			text('u2', 'user', 'medio'),
			text('a2', 'assistant', 'respuesta'),
			marker('m2'),
			text('u3', 'user', 'nuevo'),
		];

		// The carried tail may reach back past an older marker: those turns are
		// raw context for the newest summary, not a second summary to obey.
		const ids = promptWindow(messages).map((message) => message.id);
		expect(ids.slice(-3)).toEqual(['a2', 'm2', 'u3']);
		expect(ids).toContain('u2');
	});
});
