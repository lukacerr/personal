import {
	date,
	jsonb,
	pgTable,
	smallint,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * How an event repeats. `everyDays` with interval 1 is "every day"; `weekly`
 * carries ISO weekday numbers (1 = Monday … 7 = Sunday). `until` is the last
 * local date an occurrence may fall on, inclusive.
 *
 * Stored as opaque jsonb: the server never expands a series. Occurrences are
 * derived in the client over whatever window is on screen, and the only thing
 * persisted per occurrence is its completion.
 */
export type EventRecurrence =
	| { kind: 'everyDays'; interval: number; until?: string }
	| { kind: 'weekly'; weekdays: number[]; until?: string };

/**
 * A calendar entry. One entity covers the three shapes the schedule note held:
 * a timed appointment (`date` + `timeMinutes`), a day-anchored task (`date`
 * only), and a dateless backlog item (neither).
 *
 * Dates are local calendar days stored as `YYYY-MM-DD` strings, never UTC
 * instants: "the 27th" means the 27th wherever the calendar is read, and a
 * timestamp would shift it across midnight depending on the device's zone.
 * `timeMinutes` is minutes from local midnight for the same reason.
 *
 * For a recurring event, `date` anchors the series: it is the first occurrence
 * and the base the interval steps from.
 *
 * `completedAt` is the done mark of a NON-recurring event only; a recurring
 * one is checked per occurrence in `event_completion`. The router enforces
 * that split, along with `timeMinutes`/`recurrence` requiring a `date` —
 * domain invariants live there, not as CHECKs, because a 23514 would surface
 * as a bare 500 through the global handler.
 *
 * `updatedAt` is the client's edit clock, not row audit: offline edits from
 * two devices resolve last-write-wins against it, so the server stores what
 * the client stamps (bounded at the boundary) instead of `$onUpdate(now)`.
 * `createdAt` is likewise the client's creation instant, so an event created
 * offline is dated by when it was written, not by when it synced.
 */
export const event = pgTable('event', {
	id: uuid().primaryKey(),
	title: varchar({ length: 255 }).notNull(),
	/** Free-form body — the sub-bullets of the old schedule note. */
	details: varchar({ length: 4096 }),
	/** Free-form grouping for the tag filter; `null` is simply untagged. */
	tag: varchar({ length: 64 }),
	date: date({ mode: 'string' }),
	timeMinutes: smallint(),
	recurrence: jsonb().$type<EventRecurrence>(),
	completedAt: timestamp(),
	createdAt: timestamp().defaultNow().notNull(),
	updatedAt: timestamp().defaultNow().notNull(),
});
