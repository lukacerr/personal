import { note } from '@api/schema/note';
import type { Block } from '@blocknote/core';
import {
	jsonb,
	pgTable,
	primaryKey,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';
import type { Delta } from 'jsondiffpatch';

/**
 * Holds only past versions of a note. The current one lives on `note`, so a row
 * here is always something that has already been superseded.
 *
 * Versions are stored as reverse deltas: `delta` applied to the version at
 * `baseCreatedAt` yields this version, and a `baseCreatedAt` equal to the
 * note's `updatedAt` means the chain is anchored at the current document.
 *
 * Exactly one of `content` or (`delta` + `baseCreatedAt`) is set. `content` is
 * used for keyframes and for saves that arrive out of order, which stay
 * standalone instead of being spliced into someone else's chain.
 */
export const noteMutation = pgTable(
	'note_mutation',
	{
		noteId: uuid()
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		createdAt: timestamp().notNull(),
		content: jsonb().$type<Block[]>(),
		delta: jsonb().$type<Delta>(),
		baseCreatedAt: timestamp(),
	},
	// The composite primary key also serves newest-first reads: a btree scans
	// backwards as cheaply as forwards, so no separate descending index.
	(t) => [primaryKey({ columns: [t.noteId, t.createdAt] })],
);
