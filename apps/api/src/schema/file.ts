import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * A file that exists in object storage.
 *
 * There is deliberately no `uploadId` or `uploadedAt` column: an upload in
 * progress is not a half-existing file, it is an intention that may still come
 * to nothing. Modelling it as a row would force every read to remember to
 * filter it out, hold the name hostage for something that may never arrive, and
 * litter the table with the remains of every cancelled upload. The in-flight
 * state lives in Redis under a TTL instead, so every row here has its object in
 * storage by construction and `createdAt` really is when the file came to be.
 *
 * The storage key is `files/<id>` and never changes. Name and folder live only
 * here, which makes renaming or moving a plain `UPDATE`: never a `CopyObject` +
 * `DeleteObject`, which is not atomic and leaves debris when it fails halfway.
 */
export const file = pgTable(
	'file',
	{
		id: uuid().primaryKey(),
		name: varchar({ length: 255 }).notNull(),
		/** Containing folder; `null` is the root. Folders are derived, not stored. */
		path: varchar({ length: 1024 }),
		contentType: varchar({ length: 255 }).notNull(),
		/** Bytes, as reported by storage itself rather than by the uploading client. */
		size: bigint({ mode: 'number' }).notNull(),
		/** Readable by anyone holding the link, through the public router only. */
		isPublic: boolean().notNull().default(false),
		/**
		 * Uploaded from the Notes editor rather than the Storage explorer. Notes
		 * never deletes a file when its block goes away, so this is what makes it
		 * possible to later ask which of those files nothing references anymore.
		 */
		uploadedFromNotes: boolean().notNull().default(false),
		createdAt: timestamp().defaultNow().notNull(),
		updatedAt: timestamp()
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		uniqueIndex('file_path_name_unique').on(
			sql`lower(coalesce(${t.path}, ''))`,
			sql`lower(${t.name})`,
		),
	],
);
