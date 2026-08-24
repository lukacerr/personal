import {
	dropCachedMessages,
	readCachedMessages,
	writeCachedMessages,
} from '@api/agent-cache';
import {
	type AgentModel,
	agentModelCatalog,
	buildProviderOptions,
	cacheBreakpoint,
	findModel,
	resolveModel,
} from '@api/agent-models';
import {
	type AgentSelection,
	agentSelectionSchema,
	agentSettingsSchema,
	agentSettingsStore,
} from '@api/agent-settings';
import { agentToolCatalog, pickTools } from '@api/agent-tools';
import { authPlugin } from '@api/auth';
import { db } from '@api/env';
import { createIndexCache } from '@api/http-cache';
import { likeContaining } from '@api/like-patterns';
import {
	type AgentMessageMetadata,
	agentMessage,
	agentThread,
} from '@api/schema';
import { dateTimestampMs } from '@api/validation';
import {
	consumeStream,
	convertToModelMessages,
	createUIMessageStreamResponse,
	generateText,
	getToolOrDynamicToolName,
	isStepCount,
	isToolUIPart,
	type ModelMessage,
	streamText,
	type ToolSet,
	toUIMessageStream,
	type UIMessage,
	validateUIMessages,
} from 'ai';
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	sql,
} from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

/**
 * Byte-stable on purpose: Anthropic's prompt cache is a prefix match, so any
 * per-request interpolation here (a date, the thread title) would invalidate
 * every cached turn of every thread.
 *
 * The rendering section is a contract with the web, not decoration: a model
 * that does not know a capability exists never uses it, and one that assumes a
 * capability that does not exist writes syntax the reader sees raw. **When the
 * transcript's renderer gains or loses a feature, this text changes in the
 * same commit** — see the web's `components/agent/AGENTS.md`.
 */
export const SYSTEM_PROMPT = `You are a helpful assistant.

You are assisting Luka, a software engineer studying computer science. Reply in
Spanish unless Luka asks for another language.

Be direct, factual, realistic, and honest, even when the answer may be
uncomfortable. Be objective while explaining facts and opinionated in your
conclusions. Do not assume complexity: say things as they are. Do not hedge
certainty: state what you know, qualify only genuine uncertainty, and say what
would resolve it. Prefer current, practical approaches.

Be concise and informative. Lead with the answer; use Markdown and simple lists
instead of long paragraphs unless depth is needed. Use no filler introductions
or repetitive conclusions. When a question has several viable ways forward,
give the relevant options and their trade-offs. In code, provide the smallest
snippet that answers the question. Avoid code comments unless they explain
non-obvious reasoning.

Your replies are rendered as GitHub-flavoured Markdown in a chat UI. Use these
capabilities when they make an answer clearer, and do not use syntax that is
not listed here — it would reach the reader as raw characters.

Supported:
- Headings, bold, italic, strikethrough, blockquotes, nested lists and task
  lists, tables, links, and \`inline code\`.
- Fenced code blocks with syntax highlighting. Always tag the language.
- ==Highlighted text== with double equals, for the one phrase that matters.
- Inline math between single dollars, like $E = mc^2$.
- Display math in a fence with the delimiters on their own lines:
  $$
  x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
  $$
  A one-line $$…$$ renders inline instead of centred, so use the fenced form
  for anything you want displayed.
- Mermaid diagrams in a \`\`\`mermaid fence: flowcharts, sequence, state, class,
  ER and Gantt. Prefer one for anything with more than three related steps.

Because single dollars open inline math, write a currency amount either as
"100 USD" or with an escaped dollar (\\$100), or it will be parsed as a formula.`;

const LUKA_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const lukaDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: LUKA_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
	timeZoneName: 'longOffset',
});

/** Dynamic context follows the cacheable prompt, so it does not break its prefix. */
export function currentContextPrompt(now = new Date()) {
	const parts = Object.fromEntries(
		lukaDateTimeFormatter
			.formatToParts(now)
			.filter((part) => part.type !== 'literal')
			.map((part) => [part.type, part.value]),
	);
	const offset = parts.timeZoneName.replace('GMT', 'UTC');

	return `Luka lives in San Nicolas, CABA, Argentina. Current local time: ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset} (${LUKA_TIME_ZONE}).`;
}

const TITLE_MAX_CHARS = 80;
const RETITLE_TRANSCRIPT_MAX_CHARS = 8_000;

/** Provider work is bounded below the lease so a live request cannot lose it. */
const MUTATION_LEASE_MS = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = MUTATION_LEASE_MS - 30_000;

/** Roughly how much of a message rides along each search hit, per side. */
export const SNIPPET_RADIUS = 70;

const threadId = z.uuid();

/**
 * A cursor read back out of a previous page, so it is a stored clock and not a
 * client edit clock: the only bound it needs is what `Date` can hold. Query
 * strings arrive as text, hence the coercion in front of the shared validator.
 */
const cursorTimestampMs = z.coerce.number().pipe(dateTimestampMs);

/** `position` is an int4 in Postgres, and out of range is an error, not a miss. */
const messagePosition = z.coerce.number().int().min(1).max(2_147_483_647);

/**
 * `after` alone accepts 0, which positions never take: it means "after the
 * start of the thread", the one way to ask for the **oldest** page in a single
 * bounded request. Without it, jumping to the beginning of a conversation
 * would have to walk every page backwards to find out where it begins.
 */
const afterPosition = z.coerce.number().int().min(0).max(2_147_483_647);

const pageLimit = (max: number, fallback: number) =>
	z.coerce.number().int().min(1).max(max).default(fallback);

/**
 * The envelope is validated here; `parts` belongs to the AI SDK and is
 * validated by `validateUIMessages` together with the stored history.
 */
const userMessage = z
	.object({
		id: z.uuid(),
		role: z.literal('user'),
		parts: z.array(z.unknown()).min(1),
	})
	.refine(
		(message) => JSON.stringify(message.parts).length <= 256 * 1024,
		'Message exceeds 256 KiB',
	);

const chatBody = z.object({
	threadId,
	...agentSelectionSchema.shape,
	tools: agentSelectionSchema.shape.tools.default([]),
	maxSteps: agentSelectionSchema.shape.maxSteps.default(5),
	message: userMessage,
});

const bulkThreadIds = z
	.array(threadId)
	.min(1)
	.max(100)
	.refine(
		(ids) => new Set(ids).size === ids.length,
		'Thread ids must be unique',
	);

function alignsWithStep(value: number, min: number, step: number) {
	const offset = (value - min) / step;
	const tolerance = Number.EPSILON * Math.max(1, Math.abs(offset)) * 16;
	return Math.abs(offset - Math.round(offset)) <= tolerance;
}

function validateAgentSelection(selection: AgentSelection) {
	const model = findModel(selection.model);
	if (!model) return { error: 'AGENT_MODEL_UNKNOWN' as const };
	const reasoning = selection.reasoning ?? model.reasoning.default;
	if (
		selection.reasoning !== undefined &&
		!model.reasoning.levels.includes(selection.reasoning)
	)
		return { error: 'AGENT_REASONING_UNKNOWN' as const };
	if (
		selection.temperature !== undefined &&
		(model.temperature === null ||
			reasoning === undefined ||
			!model.temperature.reasoning.includes(reasoning) ||
			selection.temperature < model.temperature.min ||
			selection.temperature > model.temperature.max ||
			!alignsWithStep(
				selection.temperature,
				model.temperature.min,
				model.temperature.step,
			))
	)
		return { error: 'AGENT_TEMPERATURE_UNSUPPORTED' as const };
	const picked = pickTools(selection.tools);
	if (picked.unknown.length > 0)
		return { error: 'AGENT_TOOL_UNKNOWN' as const };
	return { model, reasoning, picked };
}

/**
 * A thread as the wire carries it: epoch ms instead of `Date`, and every
 * field named. A generic spread-and-override (`{ ...row, createdAt: number }`)
 * types as `T & { createdAt: number }` — an intersection where `createdAt` is
 * `Date & number`, which no value can satisfy — so Eden handed the web a
 * shape it could not construct in a test. Naming the fields also makes a new
 * column an explicit decision rather than an accidental part of the contract.
 */
function timestamps(row: typeof agentThread.$inferSelect) {
	return {
		id: row.id,
		title: row.title,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * The remembered tag of `GET /agent/threads`. Every handler below that writes
 * the agent tables drops it before responding; the chat stream drops it when
 * the exchange persists.
 */
const indexCache = createIndexCache('agent');

async function readThread(id: string) {
	const [thread] = await db
		.select({
			id: agentThread.id,
			title: agentThread.title,
			incarnation: agentThread.incarnation,
			revision: agentThread.revision,
		})
		.from(agentThread)
		.where(eq(agentThread.id, id))
		.limit(1);
	return thread;
}

async function claimThreadMutation(threadId: string, owner: string) {
	const [thread] = await db
		.update(agentThread)
		.set({
			mutationOwner: owner,
			mutationExpiresAt: sql`clock_timestamp() + (${MUTATION_LEASE_MS}::bigint * interval '1 millisecond')`,
		})
		.where(
			and(
				eq(agentThread.id, threadId),
				sql`(${agentThread.mutationOwner} is null or ${agentThread.mutationExpiresAt} <= clock_timestamp())`,
			),
		)
		.returning({
			id: agentThread.id,
			title: agentThread.title,
			incarnation: agentThread.incarnation,
			revision: agentThread.revision,
		});
	return thread;
}

async function failedThreadClaim(threadId: string) {
	return (await readThread(threadId))
		? status(409, { error: 'AGENT_THREAD_BUSY' })
		: status(404, { error: 'AGENT_THREAD_NOT_FOUND' });
}

async function releaseThreadMutation(threadId: string, owner: string) {
	await db
		.update(agentThread)
		.set({ mutationOwner: null, mutationExpiresAt: null })
		.where(
			and(eq(agentThread.id, threadId), eq(agentThread.mutationOwner, owner)),
		);
}

async function renewThreadMutation(threadId: string, owner: string) {
	const renewed = await db
		.update(agentThread)
		.set({
			mutationExpiresAt: sql`clock_timestamp() + (${MUTATION_LEASE_MS}::bigint * interval '1 millisecond')`,
		})
		.where(
			and(eq(agentThread.id, threadId), eq(agentThread.mutationOwner, owner)),
		)
		.returning({ id: agentThread.id });
	return renewed.length > 0;
}

/**
 * One page of the thread index, newest first. The keyset compares
 * `(updated_at, id)` as a tuple against the last row of the previous page:
 * `updated_at` alone is not unique — a rename and an exchange land in the same
 * millisecond often enough — and without the id tiebreak a page boundary that
 * falls inside a group of equal clocks either repeats a thread or skips one.
 * The timestamp is interpolated as the same UTC wall-clock ISO string Drizzle
 * writes, so the comparison does not depend on the server's timezone.
 *
 * One row past the limit is read to learn whether a next page exists, which is
 * cheaper than a `count` over an index that grows forever.
 */
async function readThreadPage(
	limit: number,
	cursor: { updatedAt: number; id: string } | undefined,
	search: string | undefined,
) {
	const rows = await db
		.select()
		.from(agentThread)
		.where(
			and(
				cursor
					? sql`(${agentThread.updatedAt}, ${agentThread.id}) < (${new Date(
							cursor.updatedAt,
						).toISOString()}::timestamp, ${cursor.id}::uuid)`
					: undefined,
				search
					? sql`${agentThread.title} ilike ${likeContaining(search)} escape '\\'`
					: undefined,
			),
		)
		.orderBy(desc(agentThread.updatedAt), desc(agentThread.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		threads: page.map(timestamps),
		nextCursor:
			rows.length > limit && last
				? { updatedAt: last.updatedAt.getTime(), id: last.id }
				: null,
	};
}

/** Whether anything sits past an edge of the returned window. Index-only. */
async function hasMessageOutside(
	threadId: string,
	side: 'older' | 'newer',
	position: number,
) {
	const [row] = await db
		.select({ position: agentMessage.position })
		.from(agentMessage)
		.where(
			and(
				eq(agentMessage.threadId, threadId),
				side === 'older'
					? lt(agentMessage.position, position)
					: gt(agentMessage.position, position),
			),
		)
		.limit(1);
	return row !== undefined;
}

/**
 * A message's plain text — what a search hit is quoted from and what a
 * derived title is cut from; `parts` also carries non-text parts.
 */
function messageText(parts: UIMessage['parts']) {
	return parts
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The excerpt around a hit, built here and not in SQL: the match is found the
 * same way the query found it, and a pure function is testable without a
 * database. A text the query does not appear in — the caller matched another
 * part of the same message — leads with its head instead of nothing.
 */
export function buildSnippet(
	text: string,
	query: string,
	radius = SNIPPET_RADIUS,
) {
	const at = text.toLowerCase().indexOf(query.toLowerCase());
	const start = at === -1 ? 0 : Math.max(0, at - radius);
	const end = Math.min(
		text.length,
		at === -1 ? radius * 2 : at + query.length + radius,
	);
	const head = start > 0 ? '…' : '';
	const tail = end < text.length ? '…' : '';
	return `${head}${text.slice(start, end)}${tail}`;
}

/** The thread's history, from Redis when it can be believed, else from Neon. */
async function readThreadMessages(
	threadId: string,
	incarnation: string,
	revision: number,
): Promise<UIMessage[]> {
	const cached = await readCachedMessages(threadId, incarnation, revision);
	if (cached) return cached;

	const rows = await db
		.select({
			id: agentMessage.id,
			role: agentMessage.role,
			parts: agentMessage.parts,
			metadata: agentMessage.metadata,
		})
		.from(agentMessage)
		.where(eq(agentMessage.threadId, threadId))
		.orderBy(asc(agentMessage.position));

	const messages = rows.map((row) => ({
		id: row.id,
		role: row.role as UIMessage['role'],
		parts: row.parts,
		...(row.metadata === null ? {} : { metadata: row.metadata }),
	}));
	await writeCachedMessages(threadId, incarnation, revision, messages);
	return messages;
}

function deriveTitle(message: UIMessage | undefined): string {
	return (
		messageText(message?.parts ?? []).slice(0, TITLE_MAX_CHARS) || 'New chat'
	);
}

/** Reads a message's metadata without trusting more shape than it needs. */
function metadataOf(message: UIMessage) {
	return message.metadata as AgentMessageMetadata | undefined;
}

const compactionMarkerIndex = (messages: UIMessage[]) =>
	messages.findLastIndex(
		(message) =>
			message.role === 'assistant' &&
			metadataOf(message)?.kind === 'compaction',
	);

/**
 * What a re-compaction summarizes: the latest summary and everything after it.
 * Persistence never uses this — the full history stays in Postgres and on
 * screen; only the prompt shrinks. A history without a marker passes through
 * whole. Strictly nothing before the marker, which is what keeps a second
 * compaction from re-reading turns the first one already replaced.
 */
export function compactionWindow(messages: UIMessage[]): UIMessage[] {
	const marker = compactionMarkerIndex(messages);
	return marker === -1 ? messages : messages.slice(marker);
}

/**
 * How much raw pre-marker conversation a turn may carry alongside the summary.
 *
 * Measured in characters, not tokens, and deliberately: tokenizing would mean a
 * per-provider dependency to enforce what is already a heuristic. At the usual
 * ~4 characters per token this is roughly 16k tokens — a few exchanges, far
 * from any model's window.
 */
export const CARRIED_CONTEXT_BUDGET_CHARS = 65_536;

/** What a message costs the prompt: every part, not only the text it shows. */
const messageSize = (message: UIMessage) =>
	JSON.stringify(message.parts).length;

/**
 * What one turn sends the provider.
 *
 * The summary is the memory of the turns it replaced, but a follow-up rarely
 * addresses the summary — it addresses what was just said ("and the second
 * one?", "apply it to that file"). So the newest summary travels with as many
 * whole exchanges before it as the budget allows, newest first.
 *
 * Whole exchanges, never part of one: a boundary inside an exchange can hand the
 * provider a tool result whose call was left behind. A re-compaction still uses
 * `compactionWindow`, so carrying this tail never makes the next summary
 * re-read it, and the prefix stays bounded no matter how long the thread grows.
 */
export function promptWindow(messages: UIMessage[]): UIMessage[] {
	const marker = compactionMarkerIndex(messages);
	if (marker === -1) return messages;

	let start = marker;
	let spent = 0;
	for (let index = marker - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) break;
		spent += messageSize(message);
		if (spent > CARRIED_CONTEXT_BUDGET_CHARS) break;
		// Only a user message opens an exchange, so only it may become the edge.
		if (message.role === 'user') start = index;
	}
	return messages.slice(start);
}

const TITLE_PROMPT = `Name the conversation that starts with the user message you receive.
Answer with the title only: at most eight words, in the language of the message,
no quotes, no trailing period.`;

function cleanGeneratedTitle(text: string) {
	return text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\.$/, '')
		.replace(/^["'“«]+|["'”»]+$/g, '')
		.trim()
		.slice(0, TITLE_MAX_CHARS);
}

function titleTranscript(messages: UIMessage[]) {
	let transcript = '';
	for (const message of messages) {
		const text = messageText(message.parts);
		if (!text) continue;
		const separator = transcript ? '\n\n' : '';
		const available = RETITLE_TRANSCRIPT_MAX_CHARS - transcript.length;
		transcript += `${separator}${message.role}: ${text}`.slice(0, available);
		if (transcript.length >= RETITLE_TRANSCRIPT_MAX_CHARS) break;
	}
	return transcript;
}

/**
 * Starts the generated-title work beside the first stream. Persistence later
 * installs its derived fallback and detaches the guarded title update, so title
 * latency never delays stream closure. A failure changes nothing, which is why
 * nothing here logs.
 */
async function generateThreadTitle(
	firstMessage: UIMessage | undefined,
	requested: AgentModel,
): Promise<string | undefined> {
	const prompt = messageText(firstMessage?.parts ?? []).slice(0, 2000);
	if (!prompt) return undefined;

	const settings = await agentSettingsStore.read();
	const cached = settings?.titleModel
		? findModel(settings.titleModel)
		: undefined;
	const candidates =
		cached && cached.id !== requested.id ? [cached, requested] : [requested];

	for (const candidate of candidates) {
		try {
			const { text } = await generateText({
				model: resolveModel(candidate),
				system: TITLE_PROMPT,
				prompt,
			});
			const title = cleanGeneratedTitle(text);
			if (title) return title;
		} catch {
			// The next candidate gets its chance; the derived title stands.
		}
	}
	return undefined;
}

async function applyGeneratedTitle(
	threadId: string,
	title: string | undefined,
	derivedTitle: string,
	revision: number,
	incarnation: string,
) {
	if (!title) return;
	const updated = await db
		.update(agentThread)
		.set({ title })
		.where(
			and(
				eq(agentThread.id, threadId),
				eq(agentThread.incarnation, incarnation),
				eq(agentThread.revision, revision),
				eq(agentThread.titleAuto, true),
				eq(agentThread.title, derivedTitle),
				isNull(agentThread.mutationOwner),
			),
		)
		.returning({ id: agentThread.id });
	if (updated.length > 0) await indexCache.invalidate();
}

/**
 * The brief is written for another assistant, not for a reader, and it is the
 * only memory of the turns it replaces. So it is structured — a follow-up that
 * says "and the other one?" needs the alternatives, and one that says "keep
 * going" needs to know where things stopped — and it is explicitly allowed to
 * be long. Compaction exists to bound an unbounded prefix, not to be small.
 */
const COMPACTION_PROMPT = `Summarize the conversation into a context brief that will replace its older turns. Another assistant will read this brief as its only memory of them, then continue the conversation.

Use these sections, in this order. Skip one only when the conversation truly has nothing for it.

## How it started
What the user originally wanted, and why. Keep their own words where the wording matters.

## What was decided
Decisions reached, and the alternatives that were rejected and why — a later turn must not reopen a settled question, and a follow-up may well ask about one of the rejected options.

## Constraints and preferences
Requirements, conventions, formats, tone, names and versions that must keep holding.

## Facts and artefacts to carry
Identifiers, paths, values, snippets and tool results a follow-up will need. Copy code, names and identifiers verbatim; never paraphrase them.

## Open questions
Anything asked and not answered, or deliberately deferred.

## Where things left off
The last thing that happened, and the next step that was obvious at that point.

Write in the conversation's language, in markdown. Prefer completeness over brevity: losing a detail costs more than a longer brief. Answer with the brief only.`;

/** Bounds the transcript one compaction may read, keeping both of its ends. */
const COMPACTION_TRANSCRIPT_MAX_CHARS = 200_000;

/**
 * What one message contributed, as text.
 *
 * Tool work is rendered rather than dropped: a thread whose substance was
 * searches and file reads used to summarize from the assistant's prose *about*
 * them, because only `text` parts survived. It is rendered as text — never
 * converted provider messages — because tool and reasoning parts convert
 * per-provider and can fail for a model that never saw them, while text
 * survives anything.
 */
function transcriptEntry(message: UIMessage): string {
	const lines = message.parts.flatMap((part) => {
		if (part.type === 'text') return part.text.trim() || [];
		if (!isToolUIPart(part)) return [];
		const name = getToolOrDynamicToolName(part);
		if (part.state === 'output-error') return `[tool ${name} failed]`;
		if (part.state !== 'output-available') return [];
		return `[tool ${name}] input: ${JSON.stringify(part.input)} output: ${JSON.stringify(part.output)}`;
	});
	const body = lines
		.join('\n')
		.replace(/[ \t]+/g, ' ')
		.trim();
	return body ? `${message.role}: ${body}` : '';
}

function transcriptOf(messages: UIMessage[]): string {
	const transcript = messages.map(transcriptEntry).filter(Boolean).join('\n\n');
	if (transcript.length <= COMPACTION_TRANSCRIPT_MAX_CHARS) return transcript;
	// Both ends, because "how it started" and "where things left off" are the
	// two sections most likely to be lost by truncating at one end.
	const half = Math.floor(COMPACTION_TRANSCRIPT_MAX_CHARS / 2);
	return `${transcript.slice(0, half)}\n\n[…]\n\n${transcript.slice(-half)}`;
}

/**
 * Writes an exchange's new messages after the stream finished. Runs inside
 * the stream's `onEnd`, when the response has already been sent — failures
 * are logged, never surfaced as a status.
 */
async function persistExchange(
	threadId: string,
	messages: UIMessage[],
	baseCount: number,
	expectedRevision: number,
	incarnation: string,
	owner: string,
) {
	const fresh = messages.slice(baseCount);
	if (fresh.length === 0) {
		await releaseThreadMutation(threadId, owner);
		return undefined;
	}
	const rows = fresh.map((message, index) => ({
		id: message.id,
		position: baseCount + index + 1,
		role: message.role,
		parts: message.parts,
		metadata: (message.metadata as AgentMessageMetadata | undefined) ?? null,
	}));
	const derivedTitle = deriveTitle(messages[0]);
	const result = await db.execute<{ revision: number }>(sql`
		with claimed as (
			update ${agentThread}
			set revision = ${agentThread.revision} + 1,
				mutation_owner = null,
				mutation_expires_at = null,
				updated_at = date_trunc('milliseconds', clock_timestamp()),
				title = case
					when ${baseCount} = 0
						and ${agentThread.titleAuto} = true
						then ${derivedTitle}
					else ${agentThread.title}
				end
			where ${agentThread.id} = ${threadId}
				and ${agentThread.incarnation} = ${incarnation}::uuid
				and ${agentThread.revision} = ${expectedRevision}
				and ${agentThread.mutationOwner} = ${owner}::uuid
			returning ${agentThread.revision}
		), upserted as (
			insert into ${agentMessage} (id, thread_id, position, role, parts, metadata)
			select incoming.id, ${threadId}::uuid, incoming.position, incoming.role,
				incoming.parts, incoming.metadata
			from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as incoming(
				id uuid, position integer, role varchar, parts jsonb, metadata jsonb
			)
			cross join claimed
			on conflict (thread_id, position) do update set
				id = excluded.id,
				role = excluded.role,
				parts = excluded.parts,
				metadata = excluded.metadata
			returning position
		), trimmed as (
			delete from ${agentMessage}
			where ${agentMessage.threadId} = ${threadId}
				and ${agentMessage.position} > ${baseCount + fresh.length}
				and exists (select 1 from claimed)
			returning position
		)
		select revision from claimed
	`);
	const revision = result.rows[0]?.revision;
	if (revision === undefined) {
		await releaseThreadMutation(threadId, owner);
		return undefined;
	}
	// Two independent Upstash keys, so one round-trip instead of two in a row.
	await Promise.all([
		writeCachedMessages(threadId, incarnation, revision, messages),
		indexCache.invalidate(),
	]);
	return revision;
}

/**
 * The provider-facing prompt: the byte-stable system message in front of the
 * converted history. Anthropic gets two cache breakpoints — one on the system
 * message (tools render before it, so this caches both) and one on the last
 * message, so each follow-up reads the whole previous turn as prefix. Other
 * providers cache implicitly and get none.
 */
async function toProviderMessages(
	model: AgentModel,
	messages: UIMessage[],
	tools: ToolSet,
): Promise<ModelMessage[]> {
	const converted = await convertToModelMessages(messages, {
		tools,
		ignoreIncompleteToolCalls: true,
	});
	const breakpoint = cacheBreakpoint(model.provider);
	if (breakpoint) {
		const last = converted.at(-1);
		if (last) last.providerOptions = { ...last.providerOptions, ...breakpoint };
	}
	return [
		{
			role: 'system',
			content: SYSTEM_PROMPT,
			...(breakpoint ? { providerOptions: breakpoint } : {}),
		},
		{ role: 'system', content: currentContextPrompt() },
		...converted,
	];
}

export const agentRouter = new Elysia({ prefix: '/agent', tags: ['Agent'] })
	.use(authPlugin)
	.get(
		'/catalog',
		() => ({ models: agentModelCatalog(), tools: agentToolCatalog() }),
		{ detail: { summary: 'List available models and tools' } },
	)
	.get(
		'/threads',
		async ({ query, request, set }) => {
			/**
			 * Half a cursor is a bug in the caller, not a first page: answering it
			 * as one would silently restart a walk the client thought it was
			 * continuing, duplicating a page and never reaching the end.
			 */
			if (
				(query.cursorUpdatedAt === undefined) !==
				(query.cursorId === undefined)
			)
				return status(422, { error: 'AGENT_CURSOR_INCOMPLETE' });

			const cursor =
				query.cursorUpdatedAt !== undefined && query.cursorId !== undefined
					? { updatedAt: query.cursorUpdatedAt, id: query.cursorId }
					: undefined;
			// A query of only whitespace filters nothing, so it is not a filter.
			const search = query.query ? query.query : undefined;

			/**
			 * Only the canonical default page is conditional. The remembered tag names the
			 * index; a tag per query string would claim freshness for a recut of it
			 * — a page, a search — that no writer knows how to invalidate. The
			 * common poll of the web is exactly this request.
			 */
			if (cursor || search || query.limit !== 30)
				return readThreadPage(query.limit, cursor, search);
			return indexCache.conditional(request, set, () =>
				readThreadPage(query.limit, undefined, undefined),
			);
		},
		{
			query: z.object({
				limit: pageLimit(100, 30),
				cursorUpdatedAt: cursorTimestampMs.optional(),
				cursorId: threadId.optional(),
				query: z.string().trim().max(120).optional(),
			}),
			detail: { summary: 'List agent threads' },
		},
	)
	.post(
		'/threads',
		async ({ body }) => {
			const [created] = await db
				.insert(agentThread)
				.values({ id: body.id, title: 'New chat' })
				.onConflictDoNothing({ target: agentThread.id })
				.returning();
			await indexCache.invalidate();

			const thread =
				created ??
				(
					await db
						.select()
						.from(agentThread)
						.where(eq(agentThread.id, body.id))
						.limit(1)
				)[0];
			if (!thread) return status(500, { error: 'AGENT_THREAD_SAVE_FAILED' });
			return status(201, timestamps(thread));
		},
		{
			body: z.object({ id: threadId }),
			detail: { summary: 'Create agent thread' },
		},
	)
	.post(
		'/chat',
		async ({ body, request, server }) => {
			const selection = validateAgentSelection(body);
			if ('error' in selection) return status(422, { error: selection.error });
			const { model, reasoning, picked } = selection;

			const mutationOwner = Bun.randomUUIDv7();
			const thread = await claimThreadMutation(body.threadId, mutationOwner);
			if (!thread) return failedThreadClaim(body.threadId);

			let history: UIMessage[];
			try {
				history = await readThreadMessages(
					body.threadId,
					thread.incarnation,
					thread.revision,
				);
			} catch (error) {
				await releaseThreadMutation(body.threadId, mutationOwner);
				throw error;
			}
			/**
			 * A regenerate resends a user message the thread already stores; the
			 * conversation restarts from just before it and `persistExchange`
			 * replaces the stale tail.
			 */
			const resendIndex = history.findIndex(
				(message) => message.id === body.message.id,
			);
			const base = resendIndex === -1 ? history : history.slice(0, resendIndex);

			let messages: UIMessage[];
			try {
				messages = await validateUIMessages({
					messages: [...base, body.message],
				});
			} catch {
				await releaseThreadMutation(body.threadId, mutationOwner);
				return status(422, { error: 'AGENT_MESSAGE_INVALID' });
			}

			/**
			 * The stats bar's clock. Started before `streamText` so the measured
			 * span is what the user waited for, prompt conversion included.
			 */
			const startedAt = Date.now();
			/**
			 * The selection half of the message metadata, built once: the `start`
			 * part reports it and the abort branch rebuilds the same object on a
			 * partial assistant message. A field added to one copy and forgotten in
			 * the other is a stats bar that lies about how the turn was run.
			 */
			const selectionMetadata: AgentMessageMetadata = {
				model: model.id,
				...(reasoning === undefined ? {} : { reasoning }),
				tools: body.tools,
				maxSteps: body.maxSteps,
				...(body.temperature === undefined
					? {}
					: { temperature: body.temperature }),
			};
			let firstTokenMs: number | undefined;
			let availableTotalTokens: number | undefined;
			let availableOutputTokens: number | undefined;

			let generationFailed = false;
			let result: ReturnType<typeof streamText>;
			try {
				const providerMessages = await toProviderMessages(
					model,
					promptWindow(messages),
					picked.tools,
				);
				if (!(await renewThreadMutation(body.threadId, mutationOwner)))
					return status(409, { error: 'AGENT_THREAD_BUSY' });
				result = streamText({
					model: resolveModel(model),
					messages: providerMessages,
					allowSystemInMessages: true,
					tools: picked.tools,
					stopWhen: isStepCount(body.maxSteps),
					...(body.temperature === undefined
						? {}
						: { temperature: body.temperature }),
					abortSignal: request.signal,
					timeout: PROVIDER_TIMEOUT_MS,
					providerOptions: buildProviderOptions(
						model,
						body.reasoning,
						body.threadId,
					),
					onError: () => {
						generationFailed = true;
					},
					onChunk: ({ chunk }) => {
						if (chunk.type === 'finish-step') {
							availableTotalTokens =
								(availableTotalTokens ?? 0) + (chunk.usage.totalTokens ?? 0);
							availableOutputTokens =
								(availableOutputTokens ?? 0) + (chunk.usage.outputTokens ?? 0);
						}
						if (firstTokenMs !== undefined) return;
						if (
							chunk.type === 'text-delta' ||
							chunk.type === 'reasoning-delta' ||
							chunk.type === 'tool-input-delta'
						)
							firstTokenMs = Date.now() - startedAt;
					},
				});
			} catch (error) {
				await releaseThreadMutation(body.threadId, mutationOwner);
				throw error;
			}

			/**
			 * Only this request drops Bun's idle cut, and only once every early
			 * return is behind us: a reasoning model or a tool call can go silent
			 * for minutes, which the 10 s default reads as a dead connection. The
			 * rest of the API — `/health`, the public routers, the OAuth callbacks
			 * — keeps the timeout. `server` is null in-process, where there is no
			 * socket to time out.
			 */
			server?.timeout(request, 0);

			const baseCount = base.length;
			const expectedRevision = thread.revision;
			const titlePromise =
				baseCount === 0 && expectedRevision === 0 && thread.title === 'New chat'
					? generateThreadTitle(messages[0], model)
					: Promise.resolve(undefined);
			return createUIMessageStreamResponse({
				stream: toUIMessageStream({
					stream: result.stream,
					tools: picked.tools,
					originalMessages: messages,
					generateMessageId: () => Bun.randomUUIDv7(),
					/**
					 * The two returns are merged into one metadata object, so the
					 * `finish` half must not repeat — nor drop — what `start` set.
					 */
					messageMetadata: ({ part }) => {
						// A copy, so nothing downstream can merge into the shared object.
						if (part.type === 'start') return { ...selectionMetadata };
						if (part.type === 'finish')
							return {
								totalTokens: part.totalUsage.totalTokens,
								outputTokens: part.totalUsage.outputTokens,
								durationMs: Date.now() - startedAt,
								...(firstTokenMs === undefined ? {} : { firstTokenMs }),
							};
						return undefined;
					},
					onEnd: async ({ messages: finalMessages, isAborted }) => {
						try {
							if (generationFailed) {
								await releaseThreadMutation(body.threadId, mutationOwner);
								return;
							}
							if (isAborted) {
								const assistant = finalMessages.at(-1);
								if (assistant?.role === 'assistant')
									assistant.metadata = {
										...(assistant.metadata as AgentMessageMetadata | undefined),
										...selectionMetadata,
										interrupted: true,
										...(availableTotalTokens === undefined
											? {}
											: { totalTokens: availableTotalTokens }),
										...(availableOutputTokens === undefined
											? {}
											: { outputTokens: availableOutputTokens }),
										durationMs: Date.now() - startedAt,
										...(firstTokenMs === undefined ? {} : { firstTokenMs }),
									};
							}
							const revision = await persistExchange(
								body.threadId,
								finalMessages,
								baseCount,
								expectedRevision,
								thread.incarnation,
								mutationOwner,
							);
							if (baseCount === 0 && revision !== undefined) {
								const firstMessage = finalMessages[0];
								const derivedTitle = deriveTitle(firstMessage);
								void titlePromise
									.then((title) =>
										applyGeneratedTitle(
											body.threadId,
											title,
											derivedTitle,
											revision,
											thread.incarnation,
										),
									)
									.catch(() => undefined);
							}
						} catch (error) {
							await releaseThreadMutation(body.threadId, mutationOwner);
							// The response already streamed; no status left to change.
							console.error('agent: persisting the exchange failed', error);
						}
					},
				}),
				/**
				 * Consumes a tee'd copy of the SSE stream server-side, so the
				 * generation runs to completion — and `onEnd` persists the exchange —
				 * even when the client aborts or disconnects mid-stream.
				 */
				consumeSseStream: consumeStream,
			});
		},
		{ body: chatBody, detail: { summary: 'Stream a chat reply' } },
	)
	.get(
		'/settings',
		async () => ({ settings: await agentSettingsStore.read() }),
		{ detail: { summary: 'Read the agent model settings' } },
	)
	.put(
		'/settings',
		async ({ body }) => {
			/**
			 * Only the boundary checks ids against the registry: a stored id that
			 * retires later must stay readable, but a new choice of a model that
			 * does not exist is a caller bug.
			 */
			for (const id of [body.titleModel, body.compactionModel])
				if (id !== undefined && !findModel(id))
					return status(422, { error: 'AGENT_MODEL_UNKNOWN' });
			if (body.selection !== undefined) {
				const selection = validateAgentSelection(body.selection);
				if ('error' in selection)
					return status(422, { error: selection.error });
			}

			if (!(await agentSettingsStore.write(body)))
				return status(503, { error: 'AGENT_SETTINGS_UNAVAILABLE' });
			// PUT replaces: what was sent is the truth, clearing included.
			return { settings: body };
		},
		{
			body: agentSettingsSchema,
			detail: { summary: 'Replace the agent model settings' },
		},
	)
	.post(
		'/threads/bulk/delete',
		async ({ body }) => {
			const deletedRows = await db
				.delete(agentThread)
				.where(inArray(agentThread.id, body.ids))
				.returning({ id: agentThread.id });
			const deletedSet = new Set(deletedRows.map((row) => row.id));
			const deleted = body.ids.filter((id) => deletedSet.has(id));

			await Promise.all(deleted.map(dropCachedMessages));
			await indexCache.invalidate();
			return { deleted };
		},
		{
			body: z.object({ ids: bulkThreadIds }),
			detail: { summary: 'Delete several agent threads' },
		},
	)
	.post(
		'/threads/:id/fork',
		async ({ params, body }) => {
			const [source] = await db
				.select()
				.from(agentThread)
				.where(eq(agentThread.id, params.id))
				.limit(1);
			if (!source) return status(404, { error: 'AGENT_THREAD_NOT_FOUND' });

			const [target] = await db
				.select({ position: agentMessage.position, role: agentMessage.role })
				.from(agentMessage)
				.where(
					and(
						eq(agentMessage.threadId, params.id),
						eq(agentMessage.id, body.messageId),
					),
				)
				.limit(1);
			/**
			 * Only a reply is a fork point: a conversation branches over what the
			 * agent answered, and forking at a user message would copy a question
			 * with no answer — a regenerate already covers that.
			 */
			if (target?.role !== 'assistant')
				return status(422, { error: 'AGENT_FORK_TARGET_INVALID' });

			const rows = await db
				.select({
					position: agentMessage.position,
					role: agentMessage.role,
					parts: agentMessage.parts,
					metadata: agentMessage.metadata,
				})
				.from(agentMessage)
				.where(
					and(
						eq(agentMessage.threadId, params.id),
						lte(agentMessage.position, target.position),
					),
				)
				.orderBy(asc(agentMessage.position));

			/**
			 * Copies, not shared rows — with fresh ids, because a message id is a
			 * regenerate cursor: were ids shared, editing a turn in one branch
			 * would name a message in the other.
			 */
			const forkedId = Bun.randomUUIDv7();
			await db.batch([
				db.insert(agentThread).values({
					id: forkedId,
					title: source.title,
					titleAuto: source.titleAuto,
				}),
				db.insert(agentMessage).values(
					rows.map((row) => ({
						id: Bun.randomUUIDv7(),
						threadId: forkedId,
						position: row.position,
						role: row.role,
						parts: row.parts,
						metadata: row.metadata,
					})),
				),
			]);
			await indexCache.invalidate();

			const [forked] = await db
				.select()
				.from(agentThread)
				.where(eq(agentThread.id, forkedId))
				.limit(1);
			if (!forked) return status(500, { error: 'AGENT_THREAD_SAVE_FAILED' });
			return status(201, timestamps(forked));
		},
		{
			params: z.object({ id: threadId }),
			body: z.object({ messageId: z.uuid() }),
			detail: { summary: 'Fork a thread from one of its replies' },
		},
	)
	.post(
		'/threads/:id/title',
		async ({ params, body }) => {
			const settings = await agentSettingsStore.read();
			const model =
				(settings?.titleModel ? findModel(settings.titleModel) : undefined) ??
				(body.model ? findModel(body.model) : undefined);
			if (!model) return status(422, { error: 'AGENT_TITLE_MODEL_MISSING' });

			const mutationOwner = Bun.randomUUIDv7();
			const thread = await claimThreadMutation(params.id, mutationOwner);
			if (!thread) return failedThreadClaim(params.id);

			let history: UIMessage[];
			try {
				history = await readThreadMessages(
					params.id,
					thread.incarnation,
					thread.revision,
				);
			} catch (error) {
				await releaseThreadMutation(params.id, mutationOwner);
				throw error;
			}
			const prompt = titleTranscript(history);
			if (!prompt) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(422, { error: 'AGENT_TITLE_EMPTY' });
			}

			let title: string;
			try {
				if (!(await renewThreadMutation(params.id, mutationOwner)))
					return status(409, { error: 'AGENT_THREAD_BUSY' });
				const generated = await generateText({
					model: resolveModel(model),
					system: TITLE_PROMPT,
					prompt,
					timeout: PROVIDER_TIMEOUT_MS,
				});
				title = cleanGeneratedTitle(generated.text);
			} catch {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(502, { error: 'AGENT_TITLE_FAILED' });
			}
			if (!title) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(502, { error: 'AGENT_TITLE_FAILED' });
			}

			const [updated] = await db
				.update(agentThread)
				.set({
					title,
					titleAuto: false,
					mutationOwner: null,
					mutationExpiresAt: null,
				})
				.where(
					and(
						eq(agentThread.id, params.id),
						eq(agentThread.incarnation, thread.incarnation),
						eq(agentThread.revision, thread.revision),
						eq(agentThread.mutationOwner, mutationOwner),
					),
				)
				.returning();
			if (!updated) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(409, { error: 'AGENT_THREAD_CONFLICT' });
			}
			await indexCache.invalidate();
			return timestamps(updated);
		},
		{
			params: z.object({ id: threadId }),
			body: z.object({ model: z.string().min(1).max(128).optional() }),
			detail: { summary: 'Regenerate an agent thread title' },
		},
	)
	.post(
		'/threads/:id/compact',
		async ({ params, body }) => {
			/**
			 * The cached choice wins; the model the UI sent along — its composer
			 * selection — is the fallback, so compaction works before anyone has
			 * opened the settings. A cached id the registry retired resolves to
			 * nothing and falls through the same way.
			 */
			const settings = await agentSettingsStore.read();
			const model =
				(settings?.compactionModel
					? findModel(settings.compactionModel)
					: undefined) ?? (body.model ? findModel(body.model) : undefined);
			if (!model)
				return status(422, { error: 'AGENT_COMPACTION_MODEL_MISSING' });
			const mutationOwner = Bun.randomUUIDv7();
			const thread = await claimThreadMutation(params.id, mutationOwner);
			if (!thread) return failedThreadClaim(params.id);

			let history: UIMessage[];
			try {
				history = await readThreadMessages(
					params.id,
					thread.incarnation,
					thread.revision,
				);
			} catch (error) {
				await releaseThreadMutation(params.id, mutationOwner);
				throw error;
			}
			if (history.length === 0) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(422, { error: 'AGENT_COMPACTION_EMPTY' });
			}

			/**
			 * A second compaction summarizes what the model currently sees — the
			 * previous summary and everything after it — not the whole thread
			 * again, so repeated compactions stay cheap as the thread grows.
			 */
			let summary: string;
			try {
				if (!(await renewThreadMutation(params.id, mutationOwner)))
					return status(409, { error: 'AGENT_THREAD_BUSY' });
				const { text } = await generateText({
					model: resolveModel(model),
					system: COMPACTION_PROMPT,
					prompt: transcriptOf(compactionWindow(history)),
					timeout: PROVIDER_TIMEOUT_MS,
				});
				summary = text.trim();
			} catch {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(502, { error: 'AGENT_COMPACTION_FAILED' });
			}
			if (!summary) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(502, { error: 'AGENT_COMPACTION_FAILED' });
			}

			const message = {
				id: Bun.randomUUIDv7(),
				role: 'assistant',
				parts: [{ type: 'text', text: summary }] as UIMessage['parts'],
				metadata: {
					kind: 'compaction',
					model: model.id,
				} satisfies AgentMessageMetadata,
			};
			const result = await db.execute(sql`
				with claimed as (
					update ${agentThread}
					set revision = ${agentThread.revision} + 1,
						mutation_owner = null,
						mutation_expires_at = null,
						updated_at = date_trunc('milliseconds', clock_timestamp())
					where ${agentThread.id} = ${params.id}
						and ${agentThread.revision} = ${thread.revision}
						and ${agentThread.mutationOwner} = ${mutationOwner}::uuid
					returning ${agentThread.id}
				), inserted as (
					insert into ${agentMessage} (id, thread_id, position, role, parts, metadata)
					select ${message.id}::uuid, ${params.id}::uuid,
						coalesce(max(${agentMessage.position}), 0) + 1,
						${message.role}, ${JSON.stringify(message.parts)}::jsonb,
						${JSON.stringify(message.metadata)}::jsonb
					from ${agentMessage}
					cross join claimed
					where ${agentMessage.threadId} = ${params.id}
					group by claimed.id
					returning id
				)
				select id from inserted
			`);
			if (result.rows.length === 0) {
				await releaseThreadMutation(params.id, mutationOwner);
				return status(409, { error: 'AGENT_THREAD_CONFLICT' });
			}
			// Cheaper to reseed on the next read than to rebuild the value here.
			await dropCachedMessages(params.id);
			await indexCache.invalidate();

			return status(201, { message });
		},
		{
			params: z.object({ id: threadId }),
			/**
			 * The composer's current model, sent as the fallback for when no
			 * compaction model was ever configured.
			 */
			body: z.object({ model: z.string().min(1).max(128).optional() }),
			detail: { summary: 'Compact a thread into a context summary' },
		},
	)
	.patch(
		'/threads/:id',
		async ({ body, params }) => {
			const [updated] = await db
				.update(agentThread)
				.set({
					title: body.title,
					titleAuto: false,
					updatedAt: new Date(),
					mutationOwner: null,
					mutationExpiresAt: null,
				})
				.where(
					and(
						eq(agentThread.id, params.id),
						sql`(${agentThread.mutationOwner} is null or ${agentThread.mutationExpiresAt} <= clock_timestamp())`,
					),
				)
				.returning();
			await indexCache.invalidate();

			if (!updated) return failedThreadClaim(params.id);
			return timestamps(updated);
		},
		{
			params: z.object({ id: threadId }),
			body: z.object({ title: z.string().trim().min(1).max(255) }),
			detail: { summary: 'Rename agent thread' },
		},
	)
	.delete(
		'/threads/:id',
		async ({ params }) => {
			// Messages fall with the thread via the FK cascade.
			await db.delete(agentThread).where(eq(agentThread.id, params.id));
			await dropCachedMessages(params.id);
			await indexCache.invalidate();
			return status(204);
		},
		{
			params: z.object({ id: threadId }),
			detail: { summary: 'Delete agent thread' },
		},
	)
	.get(
		'/threads/:id/messages',
		async ({ params, query }) => {
			/**
			 * The two cursors walk opposite ways from a window the client already
			 * holds; together they describe no window at all.
			 */
			if (query.before !== undefined && query.after !== undefined)
				return status(422, { error: 'AGENT_CURSOR_CONFLICT' });

			const ascending = query.after !== undefined;
			/**
			 * Three independent reads, so they travel together: the thread row only
			 * tells 404 from an empty thread, and the edge probe is answered by the
			 * cursor rather than by the page. `before=B` returns everything below
			 * the greatest position under `B`, so "anything newer than the window"
			 * and "anything from `B` up" are the same question — and symmetrically
			 * for `after`. That is why this does not have to wait for the rows, and
			 * it stays the expression the empty page always used.
			 */
			const [thread, rows, beyondCursor] = await Promise.all([
				readThread(params.id),
				/**
				 * Always from Postgres, never from the history cache: that key holds
				 * the whole thread, so a window can neither be served from it without
				 * fetching everything it was meant to avoid, nor seeded into it from a
				 * slice without making it a lie. The `(thread_id, position)` unique
				 * index makes each window a short range scan anyway. `/chat` keeps the
				 * cache, because a follow-up genuinely needs the whole history.
				 */
				db
					.select({
						id: agentMessage.id,
						role: agentMessage.role,
						parts: agentMessage.parts,
						metadata: agentMessage.metadata,
						position: agentMessage.position,
					})
					.from(agentMessage)
					.where(
						and(
							eq(agentMessage.threadId, params.id),
							query.before === undefined
								? undefined
								: lt(agentMessage.position, query.before),
							query.after === undefined
								? undefined
								: gt(agentMessage.position, query.after),
						),
					)
					// Without a cursor the newest page is the one that matters, so the
					// read walks backwards from the tail and the window is flipped after.
					.orderBy(
						ascending
							? asc(agentMessage.position)
							: desc(agentMessage.position),
					)
					.limit(query.limit + 1),
				query.after !== undefined
					? hasMessageOutside(params.id, 'older', query.after + 1)
					: query.before !== undefined
						? hasMessageOutside(params.id, 'newer', query.before - 1)
						: // Without a cursor the window ends at the tail: nothing is newer.
							Promise.resolve(false),
			]);
			if (!thread) return status(404, { error: 'AGENT_THREAD_NOT_FOUND' });

			// The extra row answers one side; the other needs a bounded EXISTS.
			const overflowed = rows.length > query.limit;
			const page = rows.slice(0, query.limit);
			const window = ascending ? page : page.toReversed();
			const oldest = window[0]?.position ?? null;
			const newest = window.at(-1)?.position ?? null;

			return {
				messages: window.map((row) => ({
					id: row.id,
					role: row.role,
					parts: row.parts,
					...(row.metadata === null ? {} : { metadata: row.metadata }),
				})),
				oldest,
				newest,
				/**
				 * An empty page still has to answer, and its only edge is the cursor
				 * it was asked with: `before=P` with nothing older is still preceded
				 * by everything from `P` up.
				 */
				hasOlder: ascending ? beyondCursor : overflowed,
				hasNewer: ascending ? overflowed : beyondCursor,
			};
		},
		{
			params: z.object({ id: threadId }),
			query: z.object({
				limit: pageLimit(100, 30),
				before: messagePosition.optional(),
				after: afterPosition.optional(),
			}),
			detail: { summary: 'List a window of agent thread messages' },
		},
	)
	.get(
		'/threads/:id/search',
		async ({ params, query }) => {
			const pattern = likeContaining(query.query);
			// The thread row only separates 404 from no matches, so it does not
			// have to be answered before the page it does not narrow.
			const [thread, rows] = await Promise.all([
				readThread(params.id),
				db
					.select({
						id: agentMessage.id,
						position: agentMessage.position,
						role: agentMessage.role,
						parts: agentMessage.parts,
					})
					.from(agentMessage)
					.where(
						and(
							eq(agentMessage.threadId, params.id),
							query.before === undefined
								? undefined
								: lt(agentMessage.position, query.before),
							/**
							 * Only what the thread says, never how it is stored: matching
							 * the jsonb as text would hit every part's keys — a search for
							 * `text` or `type` would return the whole thread — and every
							 * tool argument and reasoning trace along with them.
							 */
							sql`exists (
								select 1 from jsonb_array_elements(${agentMessage.parts}) as part
								where part->>'type' = 'text' and part->>'text' ilike ${pattern} escape '\\'
							)`,
						),
					)
					// A chat is searched from the present backwards.
					.orderBy(desc(agentMessage.position))
					.limit(query.limit + 1),
			]);
			if (!thread) return status(404, { error: 'AGENT_THREAD_NOT_FOUND' });

			const page = rows.slice(0, query.limit);
			const last = page.at(-1);

			return {
				matches: page.map((row) => ({
					id: row.id,
					position: row.position,
					role: row.role,
					snippet: buildSnippet(messageText(row.parts), query.query),
				})),
				nextCursor: rows.length > query.limit && last ? last.position : null,
			};
		},
		{
			params: z.object({ id: threadId }),
			query: z.object({
				query: z.string().trim().min(1).max(200),
				limit: pageLimit(50, 20),
				before: messagePosition.optional(),
			}),
			detail: { summary: 'Search a thread for text' },
		},
	);
