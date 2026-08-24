import { agentThread } from '@api/schema/agent-thread';
import type { UIMessage } from 'ai';
import {
	integer,
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * Merged from the stream's `start` and `finish` metadata events and persisted
 * with the message, so the UI can say which model produced a reply after the
 * thread has mixed several, and what that turn cost. Every field is optional:
 * a turn persisted by an older build has none of them, and a provider that
 * reports no usage leaves the token counts out.
 */
export type AgentMessageMetadata = {
	/**
	 * `compaction` marks a summary written by the compact endpoint: `/chat`
	 * feeds the model this message onward and drops the turns it summarizes,
	 * and the UI renders it as a divider rather than as a reply.
	 */
	kind?: 'compaction';
	/** Known at `start`: the selection this turn was sent with. */
	model?: string;
	reasoning?: string;
	/** The tools granted for this turn, by name. */
	tools?: string[];
	/** The generation controls selected for this turn. */
	maxSteps?: number;
	temperature?: number;
	/** True when the user stopped the stream and this is its partial result. */
	interrupted?: boolean;
	/** Known at `finish`. */
	totalTokens?: number;
	outputTokens?: number;
	/** Time to first content chunk, ms from the start of the request. */
	firstTokenMs?: number;
	/** Whole turn, tool steps included, ms. */
	durationMs?: number;
};

/**
 * One persisted `UIMessage`. UIMessages — not ModelMessages — are the storage
 * format: `parts` keeps text, reasoning, tool calls with their state and
 * sources exactly as the UI re-renders them, and the provider format is
 * derived per request with `convertToModelMessages`. The server treats
 * `parts` as opaque jsonb; its shape belongs to the AI SDK.
 */
export const agentMessage = pgTable(
	'agent_message',
	{
		id: uuid().primaryKey(),
		threadId: uuid()
			.notNull()
			.references(() => agentThread.id, { onDelete: 'cascade' }),
		/**
		 * 1-based total order of the conversation. The user and assistant halves
		 * of an exchange persist in the same transaction with the same wall
		 * clock, so a timestamp cannot order them; the protocol's array order is
		 * the truth. The unique index doubles as the ordered read path.
		 */
		position: integer().notNull(),
		role: varchar({ length: 16 }).notNull(),
		parts: jsonb().$type<UIMessage['parts']>().notNull(),
		metadata: jsonb().$type<AgentMessageMetadata>(),
		/** Audit only — never used for ordering. */
		createdAt: timestamp().defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex('agent_message_thread_position_unique').on(
			t.threadId,
			t.position,
		),
	],
);
