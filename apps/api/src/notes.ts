import { authPlugin } from '@api/auth';
import { db } from '@api/env';
import {
	isKeyframe,
	reconstructVersion,
	reverseDelta,
} from '@api/note-versions';
import { note, noteMutation } from '@api/schema';
import type { Block } from '@blocknote/core';
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const noteId = z.uuid();
const notePath = z
	.string()
	.trim()
	.max(1024)
	.nullable()
	.refine(
		(path) =>
			path === null ||
			(!path.startsWith('/') &&
				!path.endsWith('/') &&
				path
					.split('/')
					.every((part) => part !== '' && part !== '.' && part !== '..')),
		'Invalid note path',
	);

/** Largest instant `Date` can represent, so a timestamp never becomes `Invalid Date`. */
const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;
const timestampMs = z.number().int().nonnegative().max(TIMESTAMP_MAX_MS);
const coercedTimestampMs = z.coerce
	.number()
	.int()
	.nonnegative()
	.max(TIMESTAMP_MAX_MS);

/**
 * Escapes the `LIKE` metacharacters so a folder named `plan_a` or `%` matches
 * itself instead of acting as a pattern. Pairs with `escape '\'` in the query.
 */
function likeDescendantsOf(path: string) {
	return `${path.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

function isBlock(value: unknown): value is Block {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		candidate.id.length > 0 &&
		typeof candidate.type === 'string' &&
		candidate.type.length > 0 &&
		Boolean(candidate.props) &&
		typeof candidate.props === 'object' &&
		!Array.isArray(candidate.props) &&
		Array.isArray(candidate.children) &&
		candidate.children.every(isBlock)
	);
}

const blockDocument = z
	.array(z.custom<Block>(isBlock, 'Invalid BlockNote block'))
	.min(1)
	.refine(
		(content) => JSON.stringify(content).length <= 2 * 1024 * 1024,
		'Note content exceeds 2 MiB',
	);

const noteMetadataBody = z.object({
	title: z.string().trim().min(1).max(255),
	path: notePath,
});

const saveNoteBody = noteMetadataBody.extend({
	createdAt: timestampMs,
	content: blockDocument,
});

function timestamp(date: Date) {
	return date.getTime();
}

export const notesRouter = new Elysia({ prefix: '/notes', tags: ['Notes'] })
	.use(authPlugin)
	.get(
		'/',
		async () => {
			// Both timestamps live on the note itself, so listing needs no history.
			const notes = await db
				.select({
					id: note.id,
					title: note.title,
					path: note.path,
					createdAt: note.createdAt,
					updatedAt: note.updatedAt,
				})
				.from(note)
				.orderBy(note.path, note.title)
				.$withCache(false);

			return notes.map((item) => ({
				...item,
				createdAt: timestamp(item.createdAt),
				updatedAt: timestamp(item.updatedAt),
			}));
		},
		{ detail: { summary: 'List note summaries' } },
	)
	.patch(
		'/folders',
		async ({ body }) => {
			const renamed = await db
				.update(note)
				.set({
					// A path equal to `from` yields an empty tail, so this also renames the folder itself.
					path: sql<string>`${body.to} || substr(${note.path}, char_length(${body.from}) + 1)`,
				})
				.where(
					or(
						sql`lower(${note.path}) = lower(${body.from})`,
						sql`lower(${note.path}) like lower(${likeDescendantsOf(body.from)}) escape '\\'`,
					),
				)
				.returning({ id: note.id });

			return { updated: renamed.length };
		},
		{
			body: z.object({ from: notePath.unwrap(), to: notePath.unwrap() }),
			detail: { summary: 'Rename note folder' },
		},
	)
	.delete(
		'/folders',
		async ({ body }) => {
			const deleted = await db
				.delete(note)
				.where(
					or(
						sql`lower(${note.path}) = lower(${body.path})`,
						sql`lower(${note.path}) like lower(${likeDescendantsOf(body.path)}) escape '\\'`,
					),
				)
				.returning({ id: note.id });

			return { deleted: deleted.length };
		},
		{
			body: z.object({ path: notePath.unwrap() }),
			detail: { summary: 'Delete note folder' },
		},
	)
	.patch(
		'/:id',
		async ({ body, params }) => {
			const [updated] = await db
				.update(note)
				.set(body)
				.where(eq(note.id, params.id))
				.returning({ id: note.id, title: note.title, path: note.path });

			if (!updated) return status(404, { error: 'NOTE_NOT_FOUND' });
			return updated;
		},
		{
			body: noteMetadataBody,
			params: z.object({ id: noteId }),
			detail: { summary: 'Update note metadata' },
		},
	)
	.get(
		'/:id',
		async ({ params }) => {
			// The current document lives on the note: one row, no history walked.
			const [result] = await db
				.select({
					id: note.id,
					title: note.title,
					path: note.path,
					createdAt: note.createdAt,
					updatedAt: note.updatedAt,
					content: note.content,
				})
				.from(note)
				.where(eq(note.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!result) return status(404, { error: 'NOTE_NOT_FOUND' });

			return {
				...result,
				createdAt: timestamp(result.createdAt),
				updatedAt: timestamp(result.updatedAt),
			};
		},
		{
			params: z.object({ id: noteId }),
			detail: { summary: 'Get current note' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			await db.delete(note).where(eq(note.id, params.id));
			return status(204);
		},
		{
			params: z.object({ id: noteId }),
			detail: { summary: 'Delete note' },
		},
	)
	.get(
		'/:id/mutations',
		async ({ params, query }) => {
			// `note_mutation` holds only past versions, so the current one is added
			// from the note itself to make the history complete. A note edited for
			// years has thousands of versions, so the list is paged newest first and
			// `before` walks backwards from the oldest entry already shown.
			const [current] = await db
				.select({ updatedAt: note.updatedAt })
				.from(note)
				.where(eq(note.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!current) return status(404, { error: 'NOTE_NOT_FOUND' });

			const before = query.before ? new Date(query.before) : undefined;
			const head =
				before === undefined || current.updatedAt < before
					? [{ createdAt: timestamp(current.updatedAt) }]
					: [];

			// One extra row answers `hasMore` without a second count query.
			const past = await db
				.select({ createdAt: noteMutation.createdAt })
				.from(noteMutation)
				.where(
					and(
						eq(noteMutation.noteId, params.id),
						before ? lt(noteMutation.createdAt, before) : undefined,
					),
				)
				.orderBy(desc(noteMutation.createdAt))
				.limit(query.limit + 1 - head.length)
				.$withCache(false);

			const page = [
				...head,
				...past.map((mutation) => ({
					createdAt: timestamp(mutation.createdAt),
				})),
			];

			return {
				versions: page.slice(0, query.limit),
				hasMore: page.length > query.limit,
			};
		},
		{
			params: z.object({ id: noteId }),
			query: z.object({
				limit: z.coerce.number().int().min(1).max(200).default(50),
				before: coercedTimestampMs.optional(),
			}),
			detail: { summary: 'List note mutations' },
		},
	)
	.get(
		'/:id/mutations/:createdAt',
		async ({ params }) => {
			const createdAt = new Date(params.createdAt);
			const [head] = await db
				.select({ updatedAt: note.updatedAt, content: note.content })
				.from(note)
				.where(eq(note.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!head) return status(404, { error: 'NOTE_NOT_FOUND' });

			// The requested version plus every newer one: a chain of reverse deltas
			// only ever points at versions above it, and a keyframe or the note's
			// current document bounds how far up the walk actually goes.
			const rows = await db
				.select({
					createdAt: noteMutation.createdAt,
					content: noteMutation.content,
					delta: noteMutation.delta,
					baseCreatedAt: noteMutation.baseCreatedAt,
				})
				.from(noteMutation)
				.where(
					and(
						eq(noteMutation.noteId, params.id),
						gte(noteMutation.createdAt, createdAt),
					),
				)
				.orderBy(desc(noteMutation.createdAt))
				.$withCache(false);

			const known =
				createdAt.getTime() === head.updatedAt.getTime() ||
				rows.some((row) => row.createdAt.getTime() === createdAt.getTime());
			if (!known) return status(404, { error: 'NOTE_MUTATION_NOT_FOUND' });

			const content = reconstructVersion(head, rows, createdAt);
			if (!content) return status(422, { error: 'NOTE_VERSION_UNRECOVERABLE' });

			return { createdAt: timestamp(createdAt), content };
		},
		{
			params: z.object({
				id: noteId,
				createdAt: coercedTimestampMs,
			}),
			detail: { summary: 'Get note mutation' },
		},
	)
	.post(
		'/:id/mutations',
		async ({ body, params }) => {
			const createdAt = new Date(body.createdAt);
			const savedColumns = {
				id: note.id,
				title: note.title,
				path: note.path,
				createdAt: note.createdAt,
				updatedAt: note.updatedAt,
				content: note.content,
			};

			// A brand new note is written and returned in a single round trip.
			const [created] = await db
				.insert(note)
				.values({
					id: params.id,
					title: body.title,
					path: body.path,
					content: body.content,
					// A note created offline is dated by its first mutation, not by the sync.
					createdAt,
					updatedAt: createdAt,
				})
				.onConflictDoNothing({ target: note.id })
				.returning(savedColumns);

			let saved = created;

			if (!saved) {
				// The version count rides along with the note so the keyframe rule
				// costs no extra round trip.
				const [previous] = await db
					.select({
						updatedAt: note.updatedAt,
						content: note.content,
						versions: sql<number>`(
							select count(*)::int from ${noteMutation}
							where ${noteMutation.noteId} = ${params.id}
						)`,
					})
					.from(note)
					.where(eq(note.id, params.id))
					.limit(1)
					.$withCache(false);

				if (!previous) return status(500, { error: 'NOTE_SAVE_FAILED' });

				if (previous.updatedAt < createdAt) {
					// The version being replaced moves into history as the delta that
					// rebuilds it from the document superseding it, and the note takes
					// the new document. Both statements travel as one request.
					const [, updated] = await db.batch([
						db
							.insert(noteMutation)
							.values({
								noteId: params.id,
								createdAt: previous.updatedAt,
								...(isKeyframe(previous.versions + 1)
									? { content: previous.content }
									: {
											delta: reverseDelta(body.content, previous.content),
											baseCreatedAt: createdAt,
										}),
							})
							.onConflictDoNothing(),
						db
							.update(note)
							.set({
								title: body.title,
								path: body.path,
								content: body.content,
								updatedAt: createdAt,
							})
							.where(
								and(
									eq(note.id, params.id),
									eq(note.updatedAt, previous.updatedAt),
								),
							)
							.returning(savedColumns),
					]);
					saved = updated[0];
				} else {
					// An out-of-order save is not the current document, so it is kept as
					// a standalone snapshot rather than spliced into an existing chain.
					const [, current] = await db.batch([
						db
							.insert(noteMutation)
							.values({
								noteId: params.id,
								createdAt,
								content: body.content,
							})
							.onConflictDoNothing(),
						db.select(savedColumns).from(note).where(eq(note.id, params.id)),
					]);
					saved = current[0];
				}
			}

			if (!saved) return status(500, { error: 'NOTE_SAVE_FAILED' });

			return status(201, {
				...saved,
				createdAt: timestamp(saved.createdAt),
				updatedAt: timestamp(saved.updatedAt),
			});
		},
		{
			params: z.object({ id: noteId }),
			body: saveNoteBody,
			detail: { summary: 'Save note mutation' },
		},
	);
