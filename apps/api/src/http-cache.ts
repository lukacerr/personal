/**
 * Conditional responses for the two endpoints that answer with a whole index.
 *
 * The rows are still read and serialised — that part is milliseconds — but a
 * client that already holds this exact answer is told so instead of being sent
 * a payload it will throw away. Listing every file or every note is what the
 * app does after each upload, move, rename and delete, so the repeat is the
 * common case rather than the rare one.
 *
 * The tag is derived from the body itself, so it can never claim a freshness
 * the payload does not have. A version counter would be cheaper to compute and
 * would be wrong the moment a delete and an insert landed in the same tick.
 */
export function entityTag(payload: unknown) {
	return `W/"${Bun.hash(JSON.stringify(payload)).toString(36)}"`;
}

export function isUnchanged(request: Request, tag: string) {
	return request.headers.get('if-none-match') === tag;
}
