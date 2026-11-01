import {
	boolean,
	date,
	integer,
	numeric,
	pgTable,
	timestamp,
	varchar,
} from 'drizzle-orm/pg-core';

/** `skipped` is a weekday without a session; Sunday is rest and stays `null`. */
export const LOCKIN_GYM_SESSIONS = [
	'push',
	'pull',
	'legs-core',
	'cardio',
	'skipped',
] as const;

/**
 * One day of the Lock-in challenge, as logged.
 *
 * Keyed by its local `YYYY-MM-DD`, like calendar dates: a day is that day in
 * any timezone, and there is exactly one row per day to edit.
 *
 * Every answer is nullable because a day fills in over time — the weight in the
 * morning, the totals at night — and `null` is "not answered yet", never zero.
 * Whether the answers met their targets is not stored: that is a reading of
 * the row, and it lives in the client next to the targets themselves.
 */
export const lockinDay = pgTable('lockin_day', {
	date: date({ mode: 'string' }).primaryKey(),
	calories: integer(),
	proteinGrams: integer(),
	masturbated: boolean(),
	mateAndSupplements: boolean(),
	gym: varchar({ length: 16, enum: LOCKIN_GYM_SESSIONS }),
	steps: integer(),
	/** Weighed on waking. Tracked only: no target, it is not a choice. */
	weightKg: numeric({ precision: 5, scale: 2, mode: 'number' }),
	/** The night that ended this morning. */
	sleepMinutes: integer(),
	updatedAt: timestamp()
		.defaultNow()
		.notNull()
		.$onUpdate(() => new Date()),
});
