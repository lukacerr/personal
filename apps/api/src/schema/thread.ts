import { desc } from 'drizzle-orm';
import {
	boolean,
	index,
	pgTable,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

export const thread = pgTable(
	'thread',
	{
		id: uuid().primaryKey().defaultRandom(),
		title: varchar({ length: 64 }),
		isPublic: boolean().notNull().default(false),
		createdAt: timestamp().notNull().defaultNow(),
	},
	(t) => [index('thread_created_at_desc').on(desc(t.createdAt))],
);
