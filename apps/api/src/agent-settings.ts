import { cache } from '@api/env';
import { z } from 'zod';

/**
 * Global choices for the next turn plus the models used for auxiliary work.
 * They live in Redis like the finance settings; losing them only costs
 * re-picking the controls, and title/compaction readers already have fallbacks.
 *
 * This schema deliberately validates only structure, not registry membership:
 * retiring a model, reasoning level, or tool must not make stored settings
 * unreadable. The HTTP boundary validates every newly written selection.
 */

/** Prefixed by system and versioned, like every key in this shared Redis. */
export const AGENT_SETTINGS_KEY = 'agent:settings:v1';

/**
 * The ceiling of a turn's step budget. Every step is a paid provider call, so
 * an unbounded budget lets one request spend without limit — a client cannot
 * ask for more than this, and the mirror in the web schema carries the same
 * number because the web can only import types from here.
 */
export const AGENT_MAX_STEPS = 250;

export const agentSelectionSchema = z
	.object({
		model: z.string().min(1).max(128),
		reasoning: z.string().min(1).max(16).optional(),
		tools: z.array(z.string().min(1).max(64)).max(8),
		maxSteps: z.number().int().positive().max(AGENT_MAX_STEPS),
		temperature: z.number().optional(),
	})
	.strict();

export const agentSettingsSchema = z
	.object({
		selection: agentSelectionSchema.optional(),
		titleModel: z.string().min(1).max(128).optional(),
		compactionModel: z.string().min(1).max(128).optional(),
	})
	.strict();

export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

type SettingsCache = {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: AgentSettings) => Promise<unknown>;
};

export function createAgentSettingsStore<Cache extends SettingsCache>({
	cache: store,
}: {
	cache: Cache;
}) {
	return {
		/** Exposed so a test can assert what reached the cache. */
		cache: store,

		/**
		 * The shared copy, or `null` when there is none. Absent and unreadable
		 * answer the same on purpose — every consumer has a fallback, so an
		 * unparseable value behaves like no value instead of like an error.
		 */
		async read(): Promise<AgentSettings | null> {
			const raw = await store.get(AGENT_SETTINGS_KEY).catch(() => null);
			if (raw === null || raw === undefined) return null;

			const parsed = agentSettingsSchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		},

		/** Whether it was stored. A cache that is down is not an error worth 500ing. */
		async write(settings: AgentSettings) {
			// No expiry: these are not derived and nothing can recompute them.
			return store
				.set(AGENT_SETTINGS_KEY, settings)
				.then(() => true)
				.catch(() => false);
		},
	};
}

export const agentSettingsStore = createAgentSettingsStore({ cache });
