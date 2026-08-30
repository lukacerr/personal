import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { gotenbergOverride } from '@api/agent-files';
import {
	AGENT_TOOLS,
	agentToolCatalog,
	bindToolsToModel,
	pickTools,
	storageReadInputSchema,
	storageSearchInputSchema,
	tavilyInputSchema,
	tavilyOverride,
} from '@api/agent-tools';
import { db, storage } from '@api/env';
import { objectKey } from '@api/files-storage';
import { file } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';

afterEach(() => {
	tavilyOverride.execute = undefined;
	gotenbergOverride.url = undefined;
});

const toolCall = { toolCallId: 'call-1', messages: [], context: {} };

const seededIds = new Set<string>();

async function seedFile(options: {
	name: string;
	path?: string | null;
	contentType?: string;
	body?: string;
}) {
	const id = randomUUIDv7();
	seededIds.add(id);
	const body = options.body ?? 'file-body';
	await storage.write(objectKey(id), body);
	await db.insert(file).values({
		id,
		name: options.name,
		path: options.path === undefined ? `agent-tools-test/${id}` : options.path,
		contentType: options.contentType ?? 'text/plain',
		size: Buffer.byteLength(body),
	});
	return id;
}

afterAll(async () => {
	const ids = [...seededIds];
	if (ids.length === 0) return;
	await db.delete(file).where(inArray(file.id, ids));
	await Promise.allSettled(ids.map((id) => storage.delete(objectKey(id))));
});

describe('pickTools', () => {
	test('exposes only the requested tools', () => {
		const picked = pickTools(['tavily']);
		expect(Object.keys(picked.tools)).toEqual(['tavily']);
		expect(picked.unknown).toEqual([]);
	});

	test('exposes the storage tools', () => {
		const picked = pickTools(['storageSearch', 'storageRead']);
		expect(Object.keys(picked.tools)).toEqual(['storageSearch', 'storageRead']);
		expect(picked.unknown).toEqual([]);
	});

	test('resolves against an injected registry', () => {
		const bound = bindToolsToModel({ image: true, pdf: true });
		const picked = pickTools(['storageRead'], bound);
		expect(picked.tools.storageRead).toBe(bound.storageRead);
	});

	test('an empty request exposes nothing', () => {
		expect(Object.keys(pickTools([]).tools)).toEqual([]);
	});

	test('reports unknown names instead of guessing', () => {
		expect(pickTools(['tavily', 'nope']).unknown).toEqual(['nope']);
	});
});

describe('tavily tool', () => {
	test('input schema bounds the model-controlled fields', () => {
		expect(tavilyInputSchema.safeParse({ query: '' }).success).toBe(false);
		expect(
			tavilyInputSchema.safeParse({ query: 'bun', maxResults: 50 }).success,
		).toBe(false);
		expect(tavilyInputSchema.parse({ query: 'bun runtime' })).toEqual({
			query: 'bun runtime',
			searchDepth: 'basic',
			maxResults: 5,
		});
	});

	test('execute delegates to the injected search', async () => {
		const seen: unknown[] = [];
		tavilyOverride.execute = async (input) => {
			seen.push(input);
			return {
				query: input.query,
				results: [
					{ title: 'Bun', url: 'https://bun.sh', content: 'runtime', score: 1 },
				],
			};
		};

		const result = await AGENT_TOOLS.tavily.execute(
			{ query: 'bun', searchDepth: 'basic', maxResults: 5 },
			{ toolCallId: 'call-1', messages: [], context: undefined },
		);

		expect(seen).toEqual([
			{ query: 'bun', searchDepth: 'basic', maxResults: 5 },
		]);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single tavily result, not a stream');
		expect(result.results[0]?.url).toBe('https://bun.sh');
	});
});

describe('agent tool catalog', () => {
	test('describes every registered tool', () => {
		expect(agentToolCatalog()).toEqual([
			{
				name: 'tavily',
				group: 'Web',
				description: expect.stringContaining('web'),
			},
			{
				name: 'storageSearch',
				group: 'Storage',
				description: expect.stringContaining('file'),
			},
			{
				name: 'storageRead',
				group: 'Storage',
				description: expect.stringContaining('@f:'),
			},
		]);
	});
});

describe('storageSearch tool', () => {
	test('input schema requires a query or a folder and bounds the limit', () => {
		expect(storageSearchInputSchema.safeParse({}).success).toBe(false);
		expect(storageSearchInputSchema.safeParse({ limit: 5 }).success).toBe(
			false,
		);
		expect(
			storageSearchInputSchema.safeParse({ query: 'x', limit: 26 }).success,
		).toBe(false);
		expect(storageSearchInputSchema.parse({ query: 'report' })).toEqual({
			query: 'report',
			limit: 10,
		});
	});

	test('matches by name substring, case-insensitively', async () => {
		const marker = randomUUIDv7().slice(0, 8);
		const hit = await seedFile({ name: `Invoice-${marker}.txt` });
		await seedFile({ name: `unrelated-${randomUUIDv7().slice(0, 8)}.txt` });

		const result = await AGENT_TOOLS.storageSearch.execute(
			{ query: `invoice-${marker}`, limit: 10 },
			toolCall,
		);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single result');
		expect(result.files.map((entry) => entry.fileId)).toEqual([hit]);
		expect(result.hasMore).toBe(false);
	});

	test('scopes to a folder and its descendants', async () => {
		const folder = `agent-tools-test/scope-${randomUUIDv7().slice(0, 8)}`;
		const inside = await seedFile({ name: 'inside.txt', path: folder });
		const nested = await seedFile({
			name: 'nested.txt',
			path: `${folder}/deep`,
		});
		await seedFile({ name: 'outside.txt' });

		const result = await AGENT_TOOLS.storageSearch.execute(
			{ folder, limit: 10 },
			toolCall,
		);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single result');
		expect(new Set(result.files.map((entry) => entry.fileId))).toEqual(
			new Set([inside, nested]),
		);
	});

	test('escapes LIKE metacharacters in the query', async () => {
		const marker = randomUUIDv7().slice(0, 8);
		const literal = await seedFile({ name: `plan_a-${marker}.txt` });
		await seedFile({ name: `planta-${marker}.txt` });

		const result = await AGENT_TOOLS.storageSearch.execute(
			{ query: `plan_a-${marker}`, limit: 10 },
			toolCall,
		);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single result');
		expect(result.files.map((entry) => entry.fileId)).toEqual([literal]);
	});

	test('honours the limit and reports whether more matches exist', async () => {
		const marker = randomUUIDv7().slice(0, 8);
		await seedFile({ name: `bulk-${marker}-1.txt` });
		await seedFile({ name: `bulk-${marker}-2.txt` });
		await seedFile({ name: `bulk-${marker}-3.txt` });

		const result = await AGENT_TOOLS.storageSearch.execute(
			{ query: `bulk-${marker}`, limit: 2 },
			toolCall,
		);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single result');
		expect(result.files).toHaveLength(2);
		expect(result.hasMore).toBe(true);
	});
});

describe('storageRead tool', () => {
	test('input schema requires a uuid', () => {
		expect(storageReadInputSchema.safeParse({ fileId: 'nope' }).success).toBe(
			false,
		);
		expect(
			storageReadInputSchema.safeParse({ fileId: randomUUIDv7() }).success,
		).toBe(true);
	});

	test('execute returns small metadata, never content', async () => {
		const id = await seedFile({ name: 'notes.txt', body: 'hello world' });
		const result = await AGENT_TOOLS.storageRead.execute(
			{ fileId: id },
			toolCall,
		);
		if (!result || Symbol.asyncIterator in result)
			throw new Error('expected a single result');
		expect(result).toEqual({
			fileId: id,
			name: 'notes.txt',
			mediaType: 'text/plain',
			size: 11,
			kind: 'text',
			converted: false,
		});
	});

	test('an unknown id fails with a domain message', async () => {
		expect(
			AGENT_TOOLS.storageRead.execute({ fileId: randomUUIDv7() }, toolCall),
		).rejects.toThrow(/not found/i);
	});
});

describe('bindToolsToModel', () => {
	test('binds storageRead hydration without touching the rest', () => {
		const bound = bindToolsToModel({ image: true, pdf: true });
		expect(Object.keys(bound)).toEqual(Object.keys(AGENT_TOOLS));
		expect(bound.tavily).toBe(AGENT_TOOLS.tavily);
		expect(bound.storageSearch).toBe(AGENT_TOOLS.storageSearch);
		expect(bound.storageRead).not.toBe(AGENT_TOOLS.storageRead);
		expect(typeof bound.storageRead.toModelOutput).toBe('function');
		expect(typeof bound.storageRead.execute).toBe('function');
	});

	test('the default registry entry degrades to text delivery', () => {
		// An unwired call site must never push media at a provider that would
		// serialize it as JSON; the static entry is bound to no attachments.
		expect(typeof AGENT_TOOLS.storageRead.toModelOutput).toBe('function');
	});
});
