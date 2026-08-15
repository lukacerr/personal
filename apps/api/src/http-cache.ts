/**
 * Conditional responses for the endpoints that answer with a whole index.
 *
 * The tag is derived from the body itself, so it can never claim a freshness
 * the payload does not have. A version counter would be cheaper to compute and
 * would be wrong the moment a delete and an insert landed in the same tick.
 *
 * On top of that exchange sits one Redis key per system: the tag of the
 * current index. Revalidating is what the app does on every focus, reconnect
 * and mount, and the common answer is 304 — so the common poll should cost one
 * Redis GET, not a full read against Neon that gets thrown away. Neon HTTP and
 * Upstash REST cost a similar round trip, which is exactly why only this case
 * is cached: a 304 answered from the tag skips the query, the row transfer and
 * waking Neon at all, while caching the payload of a one-round-trip query
 * would just move the same cost to a different bill.
 *
 * The tag is only believed while every write path of its system drops it —
 * see `invalidate` below. A cache that affirms a freshness it does not have is
 * worse than no cache.
 */
import { cache } from '@api/env';
import { status } from 'elysia';
import { z } from 'zod';

export function entityTag(payload: unknown) {
	return `W/"${Bun.hash(JSON.stringify(payload)).toString(36)}"`;
}

export function isUnchanged(request: Request, tag: string) {
	return request.headers.get('if-none-match') === tag;
}

/**
 * The backstop, not the invalidation. Writers drop the tag before responding;
 * the TTL only bounds how long a *lost* drop — a Redis blip on exactly that
 * DEL, or a write racing a read's re-seed — can keep answering 304 for data
 * that changed. An hour keeps the cache useful across a session of focus
 * polls while capping that worst case at something a next write or a next
 * hour repairs on its own.
 */
export const INDEX_TAG_TTL_SECONDS = 60 * 60;

/** What a cached tag must look like to be believed; anything else is a miss. */
const storedTag = z.string().min(1).max(512);

export function indexTagKey(system: string) {
	// Prefixed by system and versioned, like every key in this shared Redis.
	return `${system}:index-tag:v1`;
}

type TagCache = {
	get: (key: string) => Promise<unknown>;
	set: (
		key: string,
		value: string,
		options: { ex: number },
	) => Promise<unknown>;
	del: (key: string) => Promise<unknown>;
};

/**
 * One instance per system, owned by its router. Redis being down never breaks
 * a request: an unreadable or unreachable tag is a miss, a failed re-seed is
 * skipped, and a failed drop is bounded by the TTL above.
 */
export function createIndexCache(system: string, store: TagCache = cache) {
	const key = indexTagKey(system);
	return {
		key,
		/**
		 * The whole conditional exchange in one move: answer a matching
		 * `If-None-Match` straight from the remembered tag, otherwise run the
		 * full read, tag the payload, remember the tag and answer conditionally.
		 * Returning the payload itself keeps each route's Eden response union —
		 * the client still discriminates by status.
		 */
		async conditional<Payload>(
			request: Request,
			set: { headers: { etag?: string } },
			read: () => Promise<Payload>,
		) {
			const clientTag = request.headers.get('if-none-match');
			if (clientTag !== null) {
				const known = storedTag.safeParse(
					await store.get(key).catch(() => undefined),
				);
				if (known.success && known.data === clientTag) {
					set.headers.etag = known.data;
					return status(304);
				}
			}

			const payload = await read();
			const tag = entityTag(payload);
			await store
				.set(key, tag, { ex: INDEX_TAG_TTL_SECONDS })
				.catch(() => undefined);
			set.headers.etag = tag;
			return isUnchanged(request, tag) ? status(304) : payload;
		},
		/**
		 * Called by every handler that ran an INSERT, UPDATE or DELETE against
		 * this system's tables, after the statement and before responding —
		 * unconditionally, even when the statement may have matched no rows: an
		 * extra DEL is harmless, a missed one serves stale 304s until the TTL.
		 */
		async invalidate() {
			await store.del(key).catch(() => undefined);
		},
	};
}
