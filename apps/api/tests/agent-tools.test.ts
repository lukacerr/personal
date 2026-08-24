import { afterEach, describe, expect, test } from 'bun:test';
import {
	AGENT_TOOLS,
	agentToolCatalog,
	pickTools,
	tavilyInputSchema,
	tavilyOverride,
} from '@api/agent-tools';

afterEach(() => {
	tavilyOverride.execute = undefined;
});

describe('pickTools', () => {
	test('exposes only the requested tools', () => {
		const picked = pickTools(['tavily']);
		expect(Object.keys(picked.tools)).toEqual(['tavily']);
		expect(picked.unknown).toEqual([]);
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
			{ name: 'tavily', description: expect.stringContaining('web') },
		]);
	});
});
