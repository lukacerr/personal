import { cache } from '@api/env';
import { z } from 'zod';

/**
 * The two things about Finance that belong to Luka rather than to the ledger:
 * the budget a period is measured against, and the range he last looked at.
 *
 * They live in Redis and not in Postgres, which means they can be evicted. That
 * is an accepted trade: losing them costs one budget to retype, and every
 * device keeps its own mirror, so an eviction is repaired by the next device
 * that opens the screen rather than by anyone noticing.
 *
 * Everything here takes its cache as an argument, so the orchestration is
 * testable without a Redis.
 */

/** Prefixed so it can never collide with Drizzle's global query cache. */
export const FINANCE_SETTINGS_KEY = 'finance:settings:v1';

/** Bounded so a stored timestamp can never become an `Invalid Date`. */
const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;
const timestamp = z.number().int().nonnegative().max(TIMESTAMP_MAX_MS);

export const financeSettingsSchema = z.object({
	budget: z
		.object({
			amount: z.number().positive().max(999_999_999_999.99),
			currency: z.enum(['ars', 'usd']),
		})
		.optional(),
	// Either side may be null: an open bound is a range, not a missing one.
	range: z
		.object({
			from: timestamp.nullable(),
			toExclusive: timestamp.nullable(),
		})
		.refine(
			({ from, toExclusive }) =>
				from === null || toExclusive === null || from < toExclusive,
		)
		.optional(),
});

export type FinanceSettings = z.infer<typeof financeSettingsSchema>;

type SettingsCache = {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: FinanceSettings) => Promise<unknown>;
};

export function createFinanceSettingsStore<Cache extends SettingsCache>({
	cache: store,
}: {
	cache: Cache;
}) {
	return {
		/** Exposed so a test can assert what reached the cache. */
		cache: store,

		/**
		 * The shared copy, or `null` when there is none.
		 *
		 * Absent and unreadable answer the same on purpose: a device that still has
		 * its own mirror should reseed the cache rather than adopt a shape this
		 * version cannot make sense of. An **empty** settings is neither — it is
		 * how clearing a budget travels, so it comes back as `{}`.
		 */
		async read(): Promise<FinanceSettings | null> {
			const raw = await store.get(FINANCE_SETTINGS_KEY).catch(() => null);
			if (raw === null || raw === undefined) return null;

			const parsed = financeSettingsSchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		},

		/** Whether it was stored. A cache that is down is not an error worth 500ing. */
		async write(settings: FinanceSettings) {
			// No expiry: these are not derived and nothing can recompute them.
			return store
				.set(FINANCE_SETTINGS_KEY, settings)
				.then(() => true)
				.catch(() => false);
		},
	};
}

export const financeSettingsStore = createFinanceSettingsStore({ cache });
