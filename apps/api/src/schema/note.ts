import type { Block } from '@blocknote/core';
import { sql } from 'drizzle-orm';
import {
	boolean,
	integer,
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
		/** Readable by anyone holding the link, through the public router only. */
		isPublic: boolean().notNull().default(false),
		/** Times the public router served this note. Every hit counts once. */
		viewCount: integer().notNull().default(0),
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
