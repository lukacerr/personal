/**
 * Read-through Redis cache of a thread's full history, so a follow-up costs
 * one Upstash GET instead of reading every message row out of Neon. The cache
 * is rewritten whole after each persisted exchange — the history is an
 * append-mostly array, and a partial update would have to reproduce the
 * truncation semantics of a regenerate for no gain.
 *
 * Redis being down never breaks a chat: unreadable, unreachable, or stale
 * revisions are a miss to Neon, and failed writes are skipped.
 */
import { cache } from '@api/env';
import type { UIMessage } from 'ai';
import { z } from 'zod';

const MESSAGES_TTL_SECONDS = 24 * 60 * 60;

/**
 * Upstash rejects oversized requests, so a thread past this stops being
 * cached and always reads from Neon instead of failing every write.
 */
const MAX_CACHED_JSON_BYTES = 512 * 1024;

export function threadMessagesKey(threadId: string) {
	// Prefixed by system and versioned, like every key in this shared Redis.
	return `agent:thread:${threadId}:messages:v1`;
}

/** What a cached history must look like to be believed; anything else is a miss. */
const storedMessages = z.object({
	incarnation: z.uuid(),
	revision: z.number().int().nonnegative(),
	messages: z.array(
		z.looseObject({
			id: z.string().min(1),
			role: z.string().min(1),
			parts: z.array(z.unknown()),
		}),
	),
});

type MessagesCache = {
	get: (key: string) => Promise<unknown>;
	set: (
		key: string,
		value: { incarnation: string; revision: number; messages: UIMessage[] },
		options: { ex: number },
	) => Promise<unknown>;
	del: (key: string) => Promise<unknown>;
};

export function createThreadMessagesCache({
	cache: store,
}: {
	cache: MessagesCache;
}) {
	return {
		async read(
			threadId: string,
			incarnation: string,
			revision: number,
		): Promise<UIMessage[] | undefined> {
			const raw = await store
				.get(threadMessagesKey(threadId))
				.catch(() => undefined);
			if (raw === undefined || raw === null) return undefined;
			const parsed = storedMessages.safeParse(raw);
			if (
				!parsed.success ||
				parsed.data.incarnation !== incarnation ||
				parsed.data.revision !== revision
			)
				return undefined;
			return parsed.data.messages as UIMessage[];
		},

		async write(
			threadId: string,
			incarnation: string,
			revision: number,
			messages: UIMessage[],
		) {
			const key = threadMessagesKey(threadId);
			const value = { incarnation, revision, messages };
			if (JSON.stringify(value).length > MAX_CACHED_JSON_BYTES) {
				await store.del(key).catch(() => undefined);
				return;
			}
			await store
				.set(key, value, { ex: MESSAGES_TTL_SECONDS })
				.catch(() => undefined);
		},

		async drop(threadId: string) {
			await store.del(threadMessagesKey(threadId)).catch(() => undefined);
		},
	};
}

const threadMessagesCache = createThreadMessagesCache({ cache });

export async function readCachedMessages(
	threadId: string,
	incarnation: string,
	revision: number,
): Promise<UIMessage[] | undefined> {
	return threadMessagesCache.read(threadId, incarnation, revision);
}

export async function writeCachedMessages(
	threadId: string,
	incarnation: string,
	revision: number,
	messages: UIMessage[],
) {
	return threadMessagesCache.write(threadId, incarnation, revision, messages);
}

export async function dropCachedMessages(threadId: string) {
	return threadMessagesCache.drop(threadId);
}
