/**
 * The client half of the conditional exchange that `apps/api/src/http-cache.ts`
 * serves: send the tag this device holds, read a 304 as the word that the copy
 * it already has is still current, and carry the tag of a fresh answer back out
 * so the next ask can be conditional too.
 *
 * Only the protocol lives here. The contract stays with the caller: every index
 * has a different success shape (a bare array, `{ files }`, `{ threads }`) and
 * its own error, so `accept` is the caller's shape check throwing the caller's
 * `*ApiError`. Nothing in this file learns what an index looks like, and no
 * caller repeats the three moves that are the same everywhere.
 */

/** The request options that carry the conditional header, and nothing else. */
type ConditionalRequest = {
	fetch?: { headers: { 'if-none-match': string } };
};

/** The little of an Eden reply this protocol reads; `data` is never touched. */
type ConditionalReply = {
	status: number;
	response: { headers: Pick<Headers, 'get'> };
};

/**
 * `knownTag` empty or absent asks unconditionally — there is nothing to
 * revalidate against. A caller that only revalidates some of its requests (the
 * default page of an index, never a cursor or a search) expresses that by
 * withholding the tag.
 */
export async function conditionalGet<
	Reply extends ConditionalReply,
	Value extends object,
>(
	knownTag: string | undefined,
	send: (conditional: ConditionalRequest) => Promise<Reply>,
	accept: (reply: Reply) => Value,
): Promise<(Value & { tag?: string }) | 'unchanged'> {
	// Through `fetch` rather than `headers`: Eden types the latter as the one
	// header its own contract knows about, and this one is the browser's.
	const reply = await send(
		knownTag ? { fetch: { headers: { 'if-none-match': knownTag } } } : {},
	);
	if (reply.status === 304) return 'unchanged';
	return {
		...accept(reply),
		tag: reply.response.headers.get('etag') ?? undefined,
	};
}
