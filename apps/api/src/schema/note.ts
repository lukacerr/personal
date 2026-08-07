import type { Block } from '@blocknote/core';
import { sql } from 'drizzle-orm';
import {
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * Holds the present: the current document and when it was written.
 *
 * Keeping content here means reading a note is a single row with no join, and
 * the server can always see what it stores. `note_mutation` holds only past
 * versions.
 */
export const note = pgTable(
	'note',
	{
		id: uuid().primaryKey(),
		title: varchar({ length: 255 }).notNull(),
		path: varchar({ length: 1024 }),
		content: jsonb().$type<Block[]>().notNull(),
		createdAt: timestamp().defaultNow().notNull(),
		/** Timestamp of the current version; the newest entry of the note's history. */
		updatedAt: timestamp().defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex('note_path_title_unique').on(
			sql`lower(coalesce(${t.path}, ''))`,
			sql`lower(${t.title})`,
		),
	],
);
