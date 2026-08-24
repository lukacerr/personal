import { escapeLike } from '@api/like-patterns';
import { or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Everything under a folder: its path escaped — so a folder named `plan_a` or
 * `%` matches itself instead of acting as a pattern — plus the separator and a
 * single trailing wildcard. Pairs with `escape '\'` in the query.
 */
export function likeDescendantsOf(path: string) {
	return `${escapeLike(path)}/%`;
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
