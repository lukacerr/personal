import { sql } from 'drizzle-orm';
import {
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * A personal secret — a card, an app token — kept encrypted at rest.
 *
 * `value` is always an envelope produced by the client, never a plaintext and
 * never something this table can read on its own. The API only proves on write
 * that the envelope decrypts with its copy of the secret and then discards the
 * plaintext, so a dump of this table — a Neon backup, a `db:pull` copy — reveals
 * nothing without the secret.
 *
 * That choice costs what encryption always costs: the column cannot be searched,
 * sorted or indexed on its contents, and there is deliberately no `type`,
 * `username` or `url` column to make up for it. A credential is a title and an
 * opaque blob; anything that wanted structure would want it in the plaintext,
 * where the server has no business looking.
 */
export const credential = pgTable(
	'credential',
	{
		id: uuid().primaryKey().defaultRandom(),
		title: varchar({ length: 255 }).notNull(),
		/** The `v1.<salt>.<iv>.<ciphertext>` envelope, stored exactly as it arrived. */
		value: text().notNull(),
		createdAt: timestamp().defaultNow().notNull(),
		updatedAt: timestamp()
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// Two credentials with the same name are a mistake rather than a case worth
		// supporting: the title is the only thing anyone can read without the
		// secret, so it is the only way to tell two rows apart.
		uniqueIndex('credential_title_unique').on(sql`lower(${t.title})`),
	],
);
