/**
 * The one definition of the `LIKE`/`ILIKE` escape in this API.
 *
 * A parameter is not inert just because it is bound: `LIKE` interprets what it
 * receives, so a `_` or a `%` typed by the user turns a lookup for one row into
 * a lookup for every row. Every consumer pairs these patterns with an explicit
 * `escape '\'` in its query — the escape character is not implied by SQL.
 */

/** Makes `\`, `%` and `_` stand for themselves instead of acting as pattern. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Substring search: the value anywhere inside the column. */
export function likeContaining(value: string): string {
	return `%${escapeLike(value)}%`;
}
