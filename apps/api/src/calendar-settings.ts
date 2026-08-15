import { cache } from '@api/env';
import { z } from 'zod';

/**
 * The parts of Calendar that belong to how Luka reads it rather than to the
 * events themselves: the custom day groups (a weekend plus its holiday
 * Monday) and which tags are currently hidden. View state, not records — so
 * it follows Finance's pattern: Redis, no table, no TTL, and every device
 * keeps a localStorage mirror that reseeds the cache after an eviction.
 *
 * Everything here takes its cache as an argument, so the orchestration is
 * testable without a Redis.
 */

/** Prefixed so it can never collide with Drizzle's global query cache. */
export const CALENDAR_SETTINGS_KEY = 'calendar:settings:v1';

/**
 * A local calendar day, shared with the events router: the shape check alone
 * would admit `2026-02-30`, which `Date` would roll into March in silence.
 */
export const localDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const [year, month, day] = value.split('-').map(Number);
		const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day));
		return (
			parsed.getUTCMonth() === (month ?? 1) - 1 && parsed.getUTCDate() === day
		);
	}, 'Not a calendar date');

export const calendarSettingsSchema = z.object({
	/** Consecutive days read as one bucket, like a long weekend. */
	groups: z
		.array(
			z
				.object({
					from: localDate,
					to: localDate,
					label: z.string().trim().min(1).max(40).optional(),
				})
				.refine(({ from, to }) => from <= to, 'Group ends before it starts'),
		)
		.max(50)
		.optional(),
	hiddenTags: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
	/** The untagged residue has no chip of its own, so its toggle is a flag. */
	hideUntagged: z.boolean().optional(),
});

export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;

type SettingsCache = {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: CalendarSettings) => Promise<unknown>;
};

export function createCalendarSettingsStore<Cache extends SettingsCache>({
	cache: store,
}: {
	cache: Cache;
}) {
	return {
		/** Exposed so a test can assert what reached the cache. */
		cache: store,

		/**
		 * The shared copy, or `null` when there is none. Absent and unreadable
		 * answer the same on purpose: a device with its own mirror should reseed
		 * the cache rather than adopt a shape this version cannot read. An
		 * **empty** settings is neither — it is how clearing travels.
		 */
		async read(): Promise<CalendarSettings | null> {
			const raw = await store.get(CALENDAR_SETTINGS_KEY).catch(() => null);
			if (raw === null || raw === undefined) return null;

			const parsed = calendarSettingsSchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		},

		/** Whether it was stored. A cache that is down is not an error worth 500ing. */
		async write(settings: CalendarSettings) {
			// No expiry: these are not derived and nothing can recompute them.
			return store
				.set(CALENDAR_SETTINGS_KEY, settings)
				.then(() => true)
				.catch(() => false);
		},
	};
}

export const calendarSettingsStore = createCalendarSettingsStore({ cache });
