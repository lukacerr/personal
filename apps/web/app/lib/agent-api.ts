import type { AgentMessageMetadata } from '@api';
import { authenticatedApi } from '@web/lib/authenticated-api';
import { conditionalGet } from '@web/lib/http-conditional';
import type { TreatyData } from '@web/lib/treaty-data';
import type { UIMessage } from 'ai';

export type AgentCatalog = TreatyData<
	typeof authenticatedApi.agent.catalog.get
>;
export type AgentModelInfo = AgentCatalog['models'][number];
export type AgentToolInfo = AgentCatalog['tools'][number];

type ThreadPage = Extract<
	TreatyData<typeof authenticatedApi.agent.threads.get>,
	{ threads: unknown }
>;

/** The contract itself, never a hand-written copy of it. */
export type AgentThread = ThreadPage['threads'][number];
export type AgentThreadCursor = NonNullable<ThreadPage['nextCursor']>;

/** This system's `UIMessage`, carrying the metadata the API persists. */
export type AgentUIMessage = UIMessage<AgentMessageMetadata>;

export type AgentMessagePage = {
	messages: AgentUIMessage[];
	/** Positions at the edges of this page: the cursors to walk with. */
	oldest: number | null;
	newest: number | null;
	hasOlder: boolean;
	hasNewer: boolean;
};

type ThreadSearchResponse = Extract<
	TreatyData<
		ReturnType<typeof authenticatedApi.agent.threads>['search']['get']
	>,
	{ matches: unknown }
>;
export type AgentSearchMatch = ThreadSearchResponse['matches'][number];

export type AgentSearchPage = {
	matches: AgentSearchMatch[];
	/** Position cursor for the next, older page. */
	nextCursor: number | null;
};

/** The two model choices shared across devices; both may be unset. */
export type AgentSettings = NonNullable<
	TreatyData<typeof authenticatedApi.agent.settings.get>['settings']
>;

/**
 * Page sizes. The server defaults to the same numbers, but its schema types
 * `limit` as required once it has a default, so the client always says it.
 */
export const THREAD_PAGE_SIZE = 30;
export const MESSAGE_PAGE_SIZE = 30;
const SEARCH_LIMIT = 20;

export class AgentApiError extends Error {
	constructor(readonly status: number) {
		super(`Agent API returned ${status}`);
	}
}

export async function readCatalog(): Promise<AgentCatalog> {
	const response = await authenticatedApi.agent.catalog.get();
	if (response.status !== 200 || !response.data || !('models' in response.data))
		throw new AgentApiError(response.status);
	return response.data;
}

/**
 * One page of the index, newest first. The default page — no cursor, no query
 * — is the one the shell revalidates on every sign of life, so it is the only
 * one that carries an entity tag: a tag for a cursor or a search would claim
 * freshness for a slice rather than for the index.
 */
export function listThreads(options?: {
	cursor?: AgentThreadCursor;
	query?: string;
	limit?: number;
	knownTag?: string;
}): Promise<
	| {
			threads: AgentThread[];
			nextCursor: AgentThreadCursor | null;
			tag?: string;
	  }
	| 'unchanged'
> {
	const query = {
		limit: options?.limit ?? THREAD_PAGE_SIZE,
		...(options?.cursor
			? {
					cursorUpdatedAt: options.cursor.updatedAt,
					cursorId: options.cursor.id,
				}
			: {}),
		...(options?.query ? { query: options.query } : {}),
	};
	/** Only the default page revalidates, so only it hands over its tag. */
	const knownTag =
		options?.cursor || options?.query ? undefined : options?.knownTag;

	return conditionalGet(
		knownTag,
		(conditional) =>
			authenticatedApi.agent.threads.get({ query, ...conditional }),
		(response) => {
			if (
				response.status !== 200 ||
				!response.data ||
				!('threads' in response.data)
			)
				throw new AgentApiError(response.status);
			return {
				threads: response.data.threads,
				nextCursor: response.data.nextCursor,
			};
		},
	);
}

/**
 * Narrows a thread response to its success member instead of asserting it.
 *
 * `Extract` is what keeps this honest: the union comes from Eden, so if a
 * mutation ever answers with a different shape — a wrapper object, a renamed
 * field — the extracted type becomes `never` and every caller stops compiling,
 * which an `as AgentThread` would have hidden until it read `undefined`.
 */
const isThread = <T>(data: T): data is Extract<T, { title: string }> =>
	!!data && typeof data === 'object' && 'title' in data;

function asThread<T>(response: { data: T; status: number }) {
	const { data, status } = response;
	if (status < 200 || status >= 300 || !isThread(data))
		throw new AgentApiError(status);
	return data;
}

/** Idempotent: the id is the client's, so a retry converges on the same row. */
export async function createThread(id: string): Promise<AgentThread> {
	const response = await authenticatedApi.agent.threads.post({ id });
	return asThread(response);
}

export async function renameThread(
	id: string,
	title: string,
): Promise<AgentThread> {
	const response = await authenticatedApi.agent
		.threads({ id })
		.patch({ title });
	return asThread(response);
}

export async function deleteThread(id: string) {
	const response = await authenticatedApi.agent.threads({ id }).delete();
	if (response.status !== 204) throw new AgentApiError(response.status);
}

export async function generateThreadTitle(
	id: string,
	fallbackModel: string,
): Promise<AgentThread> {
	const response = await authenticatedApi.agent
		.threads({ id })
		.title.post({ model: fallbackModel });
	return asThread(response);
}

export async function bulkDeleteThreads(ids: string[]) {
	const response = await authenticatedApi.agent.threads.bulk.delete.post({
		ids,
	});
	if (
		response.status !== 200 ||
		!response.data ||
		!('deleted' in response.data)
	)
		throw new AgentApiError(response.status);
	return response.data.deleted;
}

/**
 * A window of one conversation. No cursor asks for the newest page; `before`
 * walks into the past and `after` back towards the present.
 */
export async function readThreadMessages(
	threadId: string,
	window?: { before?: number; after?: number; limit?: number },
): Promise<AgentMessagePage> {
	const response = await authenticatedApi.agent
		.threads({ id: threadId })
		.messages.get({
			query: {
				limit: window?.limit ?? MESSAGE_PAGE_SIZE,
				...(window?.before === undefined ? {} : { before: window.before }),
				...(window?.after === undefined ? {} : { after: window.after }),
			},
		});
	if (
		response.status !== 200 ||
		!response.data ||
		!('messages' in response.data)
	)
		throw new AgentApiError(response.status);
	/**
	 * The one boundary that narrows the persisted jsonb to the SDK's type: the
	 * shape of `parts` belongs to the AI SDK on both sides of the wire, so the
	 * contract deliberately does not restate it. Consumers still read tool
	 * outputs through guards, never casts.
	 */
	return {
		...response.data,
		messages: response.data.messages as AgentUIMessage[],
	};
}

/**
 * A new thread that copies everything up to — and including — one of the
 * source's replies. The copies carry fresh ids, so the branches edit freely.
 */
export async function forkThread(
	threadId: string,
	messageId: string,
): Promise<AgentThread> {
	const response = await authenticatedApi.agent
		.threads({ id: threadId })
		.fork.post({ messageId });
	return asThread(response);
}

/**
 * Asks the server to summarize the thread into a compaction marker. The
 * composer's current model rides along as the fallback for when no compaction
 * model was ever configured. Slow by nature — it is one full LLM turn.
 */
export async function compactThread(threadId: string, fallbackModel: string) {
	const response = await authenticatedApi.agent
		.threads({ id: threadId })
		.compact.post({ model: fallbackModel });
	if (
		response.status !== 201 ||
		!response.data ||
		!('message' in response.data)
	)
		throw new AgentApiError(response.status);
	if (response.data.message.role !== 'assistant')
		throw new AgentApiError(response.status);
	return {
		...response.data.message,
		role: 'assistant' as const,
		parts: response.data.message.parts as AgentUIMessage['parts'],
	};
}

export async function readAgentSettings(): Promise<AgentSettings | null> {
	const response = await authenticatedApi.agent.settings.get();
	if (
		response.status !== 200 ||
		!response.data ||
		!('settings' in response.data)
	)
		throw new AgentApiError(response.status);
	return response.data.settings;
}

export async function writeAgentSettings(
	settings: AgentSettings,
): Promise<AgentSettings> {
	const response = await authenticatedApi.agent.settings.put(settings);
	if (
		response.status !== 200 ||
		!response.data ||
		!('settings' in response.data)
	)
		throw new AgentApiError(response.status);
	return response.data.settings;
}

/** Text matches inside one conversation, most recent first. */
export async function searchThread(
	threadId: string,
	query: string,
	options?: { before?: number; limit?: number },
): Promise<AgentSearchPage> {
	const searchQuery = {
		query,
		limit: options?.limit ?? SEARCH_LIMIT,
		...(options?.before === undefined ? {} : { before: options.before }),
	};
	const response = await authenticatedApi.agent
		.threads({ id: threadId })
		.search.get({ query: searchQuery });
	if (
		response.status !== 200 ||
		!response.data ||
		!('matches' in response.data)
	)
		throw new AgentApiError(response.status);
	const nextCursor =
		'nextCursor' in response.data &&
		typeof response.data.nextCursor === 'number'
			? response.data.nextCursor
			: null;
	return { matches: response.data.matches, nextCursor };
}
