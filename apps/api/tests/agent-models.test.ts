import { afterEach, describe, expect, test } from 'bun:test';
import {
	AGENT_MODELS,
	buildProviderOptions,
	cacheBreakpoint,
	findModel,
	modelOverride,
	resolveModel,
} from '@api/agent-models';
import { MockLanguageModelV4 } from 'ai/test';

describe('agent model registry', () => {
	test('lists exactly the curated models', () => {
		expect(AGENT_MODELS.map((model) => model.id)).toEqual([
			'claude-opus-5',
			'claude-sonnet-5',
			'claude-fable-5',
			'claude-haiku-4-5',
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
			'gemini-3.7-flash',
			'gemini-3.5-flash-lite',
			'gemini-3.1-pro-preview',
			'deepseek/deepseek-v4-pro-0813',
			'deepseek/deepseek-v4-flash-0731',
			'moonshotai/kimi-k3',
			'zai-org/glm-5.2',
			'minimax/minimax-m3',
			'qwen/qwen3.7-max',
		]);
	});

	test('every model declares at least one level and a default among them', () => {
		for (const model of AGENT_MODELS) {
			expect(model.reasoning.levels.length).toBeGreaterThan(0);
			if (model.reasoning.default !== undefined)
				expect(model.reasoning.levels).toContain(model.reasoning.default);
		}
	});

	/**
	 * The levels a model deliberately does **not** offer, which is the half of
	 * the registry no mapping test can reveal: an absent level is a 422 at the
	 * boundary, and adding one back by accident would silently send a provider
	 * something it rejects — or, worse, quietly stop thinking.
	 */
	test.each([
		// Thinking is always on for these; `off` does not exist.
		['claude-opus-5', 'off'],
		['claude-fable-5', 'off'],
		['moonshotai/kimi-k3', 'off'],
		['gemini-3.7-flash', 'off'],
		['gemini-3.5-flash-lite', 'off'],
		['gemini-3.1-pro-preview', 'off'],
		// Gemini 3.1 Pro Preview is the one Gemini that rejects `minimal`.
		['gemini-3.1-pro-preview', 'minimal'],
		// DeepSeek collapses these onto `high`, so they are not declared.
		['deepseek/deepseek-v4-pro-0813', 'medium'],
		['deepseek/deepseek-v4-pro-0813', 'xhigh'],
	])('%s does not offer %s', (id, level) => {
		expect(findModel(id)?.reasoning.levels).not.toContain(level);
	});

	test('finds models by id and rejects strangers', () => {
		expect(findModel('claude-sonnet-5')?.provider).toBe('anthropic');
		expect(findModel('gpt-5.6-terra')?.provider).toBe('openai');
		expect(findModel('gemini-3.7-flash')?.provider).toBe('google');
		expect(findModel('nope')).toBeUndefined();
	});
});

describe('buildProviderOptions', () => {
	const cases: [string, string | undefined, unknown][] = [
		[
			'claude-opus-5',
			'xhigh',
			{
				anthropic: {
					thinking: { type: 'adaptive', display: 'summarized' },
					effort: 'xhigh',
				},
			},
		],
		[
			'claude-fable-5',
			undefined,
			{
				anthropic: {
					thinking: { type: 'adaptive', display: 'summarized' },
					effort: 'high',
				},
			},
		],
		[
			'claude-sonnet-5',
			'off',
			{ anthropic: { thinking: { type: 'disabled' } } },
		],
		[
			'claude-sonnet-5',
			'low',
			{
				anthropic: {
					thinking: { type: 'adaptive', display: 'summarized' },
					effort: 'low',
				},
			},
		],
		[
			'claude-haiku-4-5',
			'medium',
			{ anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } } },
		],
		['claude-haiku-4-5', 'off', {}],
		['claude-haiku-4-5', undefined, {}],
		[
			'gpt-5.6-sol',
			'none',
			{ openai: { reasoningEffort: 'none', promptCacheKey: 'thread-1' } },
		],
		[
			'gpt-5.6-luna',
			undefined,
			{ openai: { reasoningEffort: 'medium', promptCacheKey: 'thread-1' } },
		],
		[
			'gemini-3.7-flash',
			'high',
			{
				google: {
					thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
				},
			},
		],
		[
			'gemini-3.5-flash-lite',
			undefined,
			{
				google: {
					thinkingConfig: { includeThoughts: true, thinkingLevel: 'minimal' },
				},
			},
		],
		// An absent level resolves to each model's own default, which differs.
		[
			'gemini-3.7-flash',
			undefined,
			{
				google: {
					thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
				},
			},
		],
		[
			'gemini-3.1-pro-preview',
			undefined,
			{
				google: {
					thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
				},
			},
		],
		[
			'gemini-3.1-pro-preview',
			'medium',
			{
				google: {
					thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
				},
			},
		],
		/**
		 * Novita. `thinking`/`enable_thinking` are unknown to
		 * `@ai-sdk/openai-compatible`, so they ride its passthrough spread and
		 * must be snake_case — the provider's wire vocabulary. Effort is the
		 * exception: the SDK owns `reasoningEffort` and renames it, and a
		 * snake_case `reasoning_effort` would be dropped.
		 */
		[
			'deepseek/deepseek-v4-pro-0813',
			'off',
			{ novita: { thinking: { type: 'disabled' }, enable_thinking: false } },
		],
		[
			'deepseek/deepseek-v4-pro-0813',
			undefined,
			{ novita: { reasoningEffort: 'high' } },
		],
		[
			'deepseek/deepseek-v4-flash-0731',
			'low',
			{ novita: { reasoningEffort: 'low' } },
		],
		['moonshotai/kimi-k3', undefined, { novita: { reasoningEffort: 'max' } }],
		['zai-org/glm-5.2', 'max', { novita: { reasoningEffort: 'max' } }],
		[
			'zai-org/glm-5.2',
			'off',
			{ novita: { thinking: { type: 'disabled' }, enable_thinking: false } },
		],
		[
			'minimax/minimax-m3',
			'adaptive',
			{ novita: { thinking: { type: 'adaptive' } } },
		],
		[
			'minimax/minimax-m3',
			undefined,
			{ novita: { thinking: { type: 'adaptive' } } },
		],
		['qwen/qwen3.7-max', 'on', { novita: { enable_thinking: true } }],
		['qwen/qwen3.7-max', undefined, { novita: { enable_thinking: true } }],
		[
			'qwen/qwen3.7-max',
			'off',
			{ novita: { thinking: { type: 'disabled' }, enable_thinking: false } },
		],
	];

	test.each(cases)('%s at %s', (id, reasoning, expected) => {
		const model = findModel(id);
		if (!model) throw new Error(`Unknown model in test: ${id}`);
		expect(buildProviderOptions(model, reasoning, 'thread-1')).toEqual(
			expected as Record<string, Record<string, never>>,
		);
	});
});

describe('cacheBreakpoint', () => {
	test('anthropic gets an ephemeral breakpoint, other providers none', () => {
		expect(cacheBreakpoint('anthropic')).toEqual({
			anthropic: { cacheControl: { type: 'ephemeral' } },
		});
		expect(cacheBreakpoint('openai')).toBeUndefined();
		expect(cacheBreakpoint('google')).toBeUndefined();
		expect(cacheBreakpoint('novita')).toBeUndefined();
	});
});

describe('resolveModel', () => {
	afterEach(() => {
		modelOverride.resolve = undefined;
	});

	test('uses the injected resolver when the test seam is set', () => {
		const fake = new MockLanguageModelV4({ modelId: 'fake' });
		modelOverride.resolve = () => fake;
		const model = findModel('claude-sonnet-5');
		if (!model) throw new Error('registry lost claude-sonnet-5');
		expect(resolveModel(model)).toBe(fake);
	});
});
