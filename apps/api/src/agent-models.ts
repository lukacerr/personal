import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { env } from '@api/env';
import type { JSONValue, LanguageModel } from 'ai';

export type AgentProvider = 'anthropic' | 'google' | 'openai' | 'novita';

/**
 * The shape `streamText` accepts as `providerOptions`. The AI SDK does not
 * re-export its `ProviderOptions` type from `ai`, so this structural twin
 * keeps the mapping functions typed without depending on a transitive package.
 */
export type AgentProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * How a reasoning level travels to the provider. It is a property of the
 * model, not of the provider: current Anthropic models take adaptive thinking
 * plus an effort, while Haiku 4.5 predates adaptive and still takes a token
 * budget.
 */
type ReasoningMapping =
	| 'anthropic-adaptive'
	| 'anthropic-budget'
	| 'google-thinking'
	| 'openai-effort'
	| 'novita-thinking';

export type AgentModel = {
	id: string;
	provider: AgentProvider;
	label: string;
	/**
	 * The levels this model actually accepts, in its provider's native
	 * vocabulary — no generic scale, no clamping. Every model declares at least
	 * one; a model whose reasoning cannot be steered at all does not belong in
	 * the registry. `default` is what an absent level resolves to.
	 */
	reasoning: { levels: readonly string[]; default?: string };
	/**
	 * A null value explicitly means this model does not expose custom
	 * temperature. Otherwise `reasoning` lists the levels where the provider's
	 * knob is known to take effect, and the numeric fields fully describe the UI
	 * control without provider inference.
	 */
	temperature: {
		min: number;
		max: number;
		step: number;
		default: number;
		reasoning: readonly string[];
	} | null;
	mapping: ReasoningMapping;
};

const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const temperatureFor = (reasoning: readonly string[], max = 2) => ({
	min: 0,
	max,
	step: 0.1,
	default: 1,
	reasoning,
});

/**
 * The curated selector. Editing this list is the whole cost of adding or
 * retiring a model; the catalog endpoint, the web selector and the request
 * validation all derive from it.
 */
export const AGENT_MODELS: readonly AgentModel[] = [
	{
		id: 'claude-opus-5',
		provider: 'anthropic',
		label: 'Claude Opus 5',
		// Thinking is always on for Opus 5 and Fable 5: `off` does not exist.
		reasoning: { levels: ANTHROPIC_EFFORTS, default: 'high' },
		temperature: null,
		mapping: 'anthropic-adaptive',
	},
	{
		id: 'claude-sonnet-5',
		provider: 'anthropic',
		label: 'Claude Sonnet 5',
		reasoning: { levels: ['off', ...ANTHROPIC_EFFORTS], default: 'high' },
		temperature: null,
		mapping: 'anthropic-adaptive',
	},
	{
		id: 'claude-fable-5',
		provider: 'anthropic',
		label: 'Claude Fable 5',
		reasoning: { levels: ANTHROPIC_EFFORTS, default: 'high' },
		temperature: null,
		mapping: 'anthropic-adaptive',
	},
	{
		id: 'claude-haiku-4-5',
		provider: 'anthropic',
		label: 'Claude Haiku 4.5',
		reasoning: { levels: ['off', 'low', 'medium', 'high'], default: 'off' },
		temperature: temperatureFor(['off'], 1),
		mapping: 'anthropic-budget',
	},
	{
		id: 'gpt-5.6-sol',
		provider: 'openai',
		label: 'GPT-5.6 Sol',
		reasoning: {
			levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
			default: 'medium',
		},
		temperature: null,
		mapping: 'openai-effort',
	},
	{
		id: 'gpt-5.6-terra',
		provider: 'openai',
		label: 'GPT-5.6 Terra',
		reasoning: {
			levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
			default: 'medium',
		},
		temperature: null,
		mapping: 'openai-effort',
	},
	{
		id: 'gpt-5.6-luna',
		provider: 'openai',
		label: 'GPT-5.6 Luna',
		reasoning: {
			levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
			default: 'medium',
		},
		temperature: null,
		mapping: 'openai-effort',
	},
	{
		id: 'gemini-3.7-flash',
		provider: 'google',
		label: 'Gemini 3.7 Flash',
		reasoning: { levels: ['low', 'medium', 'high'], default: 'medium' },
		temperature: null,
		mapping: 'google-thinking',
	},
	{
		id: 'gemini-3.5-flash-lite',
		provider: 'google',
		label: 'Gemini 3.5 Flash-Lite',
		reasoning: {
			levels: ['minimal', 'low', 'medium', 'high'],
			default: 'minimal',
		},
		temperature: null,
		mapping: 'google-thinking',
	},
	{
		id: 'gemini-3.1-pro-preview',
		provider: 'google',
		label: 'Gemini 3.1 Pro Preview',
		reasoning: { levels: ['low', 'medium', 'high'], default: 'high' },
		temperature: null,
		mapping: 'google-thinking',
	},
	/**
	 * Novita is one OpenAI-compatible endpoint in front of six vendors, so the
	 * knob is per model and not per provider. All six declare the `reasoning`
	 * feature in Novita's live catalog (`GET /openai/v1/models`); what differs
	 * is which vocabulary each one answers to, and that is what `levels`
	 * records. See `buildProviderOptions` for how a level reaches the wire.
	 *
	 * Confirmed against the real endpoint from the app: Novita models stream and
	 * persist turns here, and sending a level is accepted — the vocabularies
	 * below are the ones these models answer to. The transport half is pinned by
	 * the tests of `buildProviderOptions` plus the provider's own `getArgs`:
	 * unknown keys ride the passthrough spread in snake_case, and `reasoning_effort`
	 * is the exception the SDK owns (see the camelCase note in that function).
	 *
	 * One failure mode stays unknown and cannot be settled by a request that
	 * works: whether a level this registry declares but the model does not accept
	 * comes back as an HTTP error or is silently ignored. It only matters when a
	 * level here is wrong, and it is the reason the lists stay conservative —
	 * `medium`/`xhigh` are left off DeepSeek because they collapse onto `high`,
	 * and Qwen's `thinking_budget` is not exposed at all.
	 */
	{
		id: 'deepseek/deepseek-v4-pro-0813',
		provider: 'novita',
		label: 'DeepSeek V4 Pro',
		/**
		 * DeepSeek collapses `medium` and `xhigh` onto `high`, so declaring them
		 * would offer two levels that behave identically to a third.
		 */
		reasoning: { levels: ['off', 'low', 'high', 'max'], default: 'high' },
		temperature: temperatureFor(['off']),
		mapping: 'novita-thinking',
	},
	{
		id: 'deepseek/deepseek-v4-flash-0731',
		provider: 'novita',
		label: 'DeepSeek V4 Flash',
		// Same collapsing as the Pro variant.
		reasoning: { levels: ['off', 'low', 'high', 'max'], default: 'high' },
		temperature: temperatureFor(['off']),
		mapping: 'novita-thinking',
	},
	{
		id: 'moonshotai/kimi-k3',
		provider: 'novita',
		label: 'Kimi K3',
		// Kimi K3 cannot be turned off: it always thinks, so there is no `off`.
		reasoning: { levels: ['low', 'high', 'max'], default: 'max' },
		temperature: null,
		mapping: 'novita-thinking',
	},
	{
		id: 'zai-org/glm-5.2',
		provider: 'novita',
		label: 'GLM 5.2',
		// Only `high` and `max` are confirmed efforts for GLM 5.2.
		reasoning: { levels: ['off', 'high', 'max'], default: 'max' },
		temperature: temperatureFor(['off', 'high', 'max']),
		mapping: 'novita-thinking',
	},
	{
		id: 'minimax/minimax-m3',
		provider: 'novita',
		label: 'MiniMax M3',
		/**
		 * MiniMax M3 does not accept `reasoning_effort` at all — its thinking is
		 * a toggle, so the only levels are the two ends of it.
		 */
		reasoning: { levels: ['off', 'adaptive'], default: 'adaptive' },
		temperature: temperatureFor(['off', 'adaptive']),
		mapping: 'novita-thinking',
	},
	{
		id: 'qwen/qwen3.7-max',
		provider: 'novita',
		label: 'Qwen3.7 Max',
		/**
		 * Qwen3.7 Max takes the plain toggle. `thinking_budget` exists in Qwen's
		 * own API, but it is not verified that Novita forwards it, so it is not
		 * exposed as a level: a knob that silently does nothing is worse than no
		 * knob.
		 */
		reasoning: { levels: ['off', 'on'], default: 'on' },
		temperature: null,
		mapping: 'novita-thinking',
	},
];

export function findModel(id: string) {
	return AGENT_MODELS.find((model) => model.id === id);
}

/** What the catalog endpoint publishes: the registry minus wire details. */
export function agentModelCatalog() {
	return AGENT_MODELS.map(
		({ id, provider, label, reasoning, temperature }) => ({
			id,
			provider,
			label,
			reasoning,
			temperature,
		}),
	);
}

/** Fixed budgets for models that predate adaptive thinking (Haiku 4.5). */
const BUDGET_TOKENS: Record<string, number> = {
	low: 2048,
	medium: 8192,
	high: 16_384,
};

/**
 * Maps a validated reasoning level to the provider's wire format. Levels are
 * validated against `model.reasoning.levels` at the HTTP boundary, so this
 * only resolves absence to the model's default — it never clamps.
 */
export function buildProviderOptions(
	model: AgentModel,
	reasoning: string | undefined,
	threadId: string,
): AgentProviderOptions {
	const level = reasoning ?? model.reasoning.default;
	switch (model.mapping) {
		case 'anthropic-adaptive':
			return level === 'off'
				? { anthropic: { thinking: { type: 'disabled' } } }
				: {
						anthropic: {
							thinking: { type: 'adaptive', display: 'summarized' },
							effort: level ?? 'high',
						},
					};
		case 'anthropic-budget': {
			const budgetTokens =
				level === undefined ? undefined : BUDGET_TOKENS[level];
			return budgetTokens === undefined
				? {}
				: { anthropic: { thinking: { type: 'enabled', budgetTokens } } };
		}
		case 'openai-effort':
			return {
				openai: {
					reasoningEffort: level ?? 'medium',
					/**
					 * OpenAI's caching is implicit; the key only routes follow-ups of
					 * the same thread to the same cache shard.
					 */
					promptCacheKey: threadId,
				},
			};
		case 'google-thinking':
			return level === undefined
				? {}
				: {
						google: {
							thinkingConfig: { includeThoughts: true, thinkingLevel: level },
						},
					};
		/**
		 * Novita takes whatever its upstream vendor takes, so the level travels
		 * as that vendor's own parameter. `@ai-sdk/openai-compatible` spreads
		 * `providerOptions.novita` straight into the request body, keeping only
		 * the keys its own schema does not claim (`user`, `reasoningEffort`,
		 * `textVerbosity`, `strictJsonSchema`) — so everything else must already
		 * be in the wire's snake_case, and an unknown parameter is ignored by
		 * the provider instead of rejected. Effort is the one exception and it
		 * matters: `reasoningEffort` is claimed by that schema, and the SDK
		 * writes its own `reasoning_effort` key **after** the spread. A
		 * snake_case `reasoning_effort` here would be overwritten with
		 * `undefined` and dropped from the JSON body without a warning
		 * (verified against v3.0.35), so effort goes camelCase and the SDK
		 * renames it.
		 */
		case 'novita-thinking':
			/**
			 * `off` sends both vocabularies on purpose: `thinking.type` is what
			 * DeepSeek, GLM and MiniMax speak natively, `enable_thinking` is what
			 * Novita documents. Whichever the upstream model ignores costs
			 * nothing; sending only one would leave thinking on for the others.
			 */
			if (level === 'off')
				return {
					novita: { thinking: { type: 'disabled' }, enable_thinking: false },
				};
			// MiniMax M3's only "on" is adaptive; it has no effort scale.
			if (level === 'adaptive')
				return { novita: { thinking: { type: 'adaptive' } } };
			// Qwen3.7 Max's only "on" is the bare toggle.
			if (level === 'on') return { novita: { enable_thinking: true } };
			return level === undefined ? {} : { novita: { reasoningEffort: level } };
	}
}

/**
 * The per-message prompt-caching breakpoint. Only Anthropic uses explicit
 * breakpoints; OpenAI caches implicitly and Novita caches automatically.
 */
export function cacheBreakpoint(
	provider: AgentProvider,
): AgentProviderOptions | undefined {
	return provider === 'anthropic'
		? { anthropic: { cacheControl: { type: 'ephemeral' } } }
		: undefined;
}

/**
 * Test seam. Tests set `modelOverride.resolve` to hand the chat endpoint a
 * `MockLanguageModelV4` and restore it to `undefined` afterwards; nothing in
 * the suite may let a request reach a real provider.
 */
export const modelOverride: {
	resolve?: (model: AgentModel) => LanguageModel;
} = {};

/** Lazy so importing the registry never constructs provider clients. */
let anthropic: ReturnType<typeof createAnthropic> | undefined;
let google: ReturnType<typeof createGoogleGenerativeAI> | undefined;
let openai: ReturnType<typeof createOpenAI> | undefined;
let novita: ReturnType<typeof createOpenAICompatible> | undefined;

function defaultModel(model: AgentModel): LanguageModel {
	switch (model.provider) {
		case 'anthropic':
			anthropic ??= createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
			return anthropic(model.id);
		case 'google':
			google ??= createGoogleGenerativeAI({
				apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
			});
			return google(model.id);
		case 'openai':
			openai ??= createOpenAI({ apiKey: env.OPENAI_API_KEY });
			return openai(model.id);
		case 'novita':
			novita ??= createOpenAICompatible({
				name: 'novita',
				baseURL: 'https://api.novita.ai/openai',
				apiKey: env.NOVITA_API_KEY,
			});
			return novita(model.id);
	}
}

export function resolveModel(model: AgentModel): LanguageModel {
	return (modelOverride.resolve ?? defaultModel)(model);
}
