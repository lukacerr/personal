import { event } from '@api/schema/event';
import {
	date,
	pgTable,
	primaryKey,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * The done mark of one occurrence of a recurring event. Occurrences
 * themselves are never materialised — the client expands the series over the
 * window it renders — so this table is the only per-occurrence state there is.
 *
 * `date` is the occurrence's local calendar day, same representation as
 * `event.date`. A row only ever means "this day's occurrence was resolved";
 * absence means pending. Toggling is an upsert on the composite key, and the
 * rows fall with their event via the cascade.
 */
export const eventCompletion = pgTable(
	'event_completion',
	{
		eventId: uuid()
			.notNull()
			.references(() => event.id, { onDelete: 'cascade' }),
		date: date({ mode: 'string' }).notNull(),
		status: varchar({ length: 8, enum: ['done'] }).notNull(),
		createdAt: timestamp().defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.eventId, t.date] })],
);
