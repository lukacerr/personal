import { or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Escapes the `LIKE` metacharacters so a folder named `plan_a` or `%` matches
 * itself instead of acting as a pattern. Pairs with `escape '\'` in the query.
 */
export function likeDescendantsOf(path: string) {
	return `${path.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

/**
 * The folder itself plus everything under it, case-insensitively, on whichever
 * column holds the row's path.
 */
export function inFolder(column: AnyPgColumn, path: string) {
	return or(
		sql`lower(${column}) = lower(${path})`,
		sql`lower(${column}) like lower(${likeDescendantsOf(path)}) escape '\\'`,
	);
}
