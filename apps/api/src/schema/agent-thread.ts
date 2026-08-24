import {
	boolean,
	index,
	integer,
	pgTable,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * A conversation with the agent. Deliberately thin: model, reasoning level and
 * granted tools travel with each chat request — a thread can mix models turn
 * by turn — so persisting them here would only record a stale copy of the last
 * selection. Which model produced a given reply lives on that message's
 * metadata.
 */
export const agentThread = pgTable(
	'agent_thread',
	{
		id: uuid().primaryKey(),
		/** Distinguishes delete/recreate cycles that reuse the client thread id. */
		incarnation: uuid().defaultRandom().notNull(),
		/** Derived server-side from the first user message; renameable afterwards. */
		title: varchar({ length: 255 }).notNull(),
		/** False after any explicit rename, even if text equals the auto title. */
		titleAuto: boolean().default(true).notNull(),
		/** CAS token for message-history mutations across Cloud Run instances. */
		revision: integer().default(0).notNull(),
		/** UUID lease owner for one in-flight chat or compaction. */
		mutationOwner: uuid(),
		/** Database-time crash recovery bound for the mutation lease. */
		mutationExpiresAt: timestamp({ precision: 3 }),
		createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
		/** Bumped on rename and on every persisted exchange; orders the index. */
		updatedAt: timestamp({ precision: 3 }).defaultNow().notNull(),
	},
	(t) => [
		/**
		 * Exactly the order the index is paged in, id included: the keyset
		 * compares `(updated_at, id)` as a tuple, so both columns have to be in
		 * the index — and in this direction — for a page to be a range scan
		 * instead of a sort of every thread.
		 *
		 * `nullsFirst` is not decoration: `ORDER BY x DESC` means NULLS FIRST in
		 * Postgres, and Drizzle's `.desc()` alone emits `DESC NULLS LAST`, which
		 * the planner refuses to match against that ordering even though both
		 * columns are `NOT NULL` — with that index EXPLAIN sorted the whole table.
		 */
		index('agent_thread_recency_idx').on(
			t.updatedAt.desc().nullsFirst(),
			t.id.desc().nullsFirst(),
		),
	],
);
