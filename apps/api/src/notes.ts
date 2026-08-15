import { authPlugin } from '@api/auth';
import { db } from '@api/env';
import { inFolder } from '@api/folder-paths';
import { createIndexCache } from '@api/http-cache';
import {
	isKeyframe,
	reconstructVersion,
	reverseDelta,
} from '@api/note-versions';
import { note, noteMutation } from '@api/schema';
import { TIMESTAMP_MAX_MS, timestampMs } from '@api/validation';
import type { Block } from '@blocknote/core';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const noteId = z.uuid();

/**
 * A folder, as the folder endpoints see it. The refinement lives on the
 * non-nullable schema and the nullable form is derived from it, never the
 * other way around: `.unwrap()` hands back the inner schema without the checks
 * added afterwards, so a refinement placed on the nullable parent would leave
 * the folder endpoints validating nothing but the length.
 */
const noteFolderPath = z
	.string()
	.trim()
	.max(1024)
	.refine(
		(path) =>
			!path.startsWith('/') &&
			!path.endsWith('/') &&
			path
				.split('/')
				.every((part) => part !== '' && part !== '.' && part !== '..'),
		'Invalid note path',
	);

/** The folder a note sits in, where `null` is the root. */
const notePath = noteFolderPath.nullable();

/** Reads take stored clocks back out, so they are bounded by `Date` alone. */
const coercedTimestampMs = z.coerce
	.number()
	.int()
	.nonnegative()
	.max(TIMESTAMP_MAX_MS);

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

const noteNaming = z.object({
	title: z.string().trim().min(1).max(255),
	path: notePath,
});

const noteMetadataBody = noteNaming.extend({ isPublic: z.boolean() });

/**
 * Saving content deliberately cannot change visibility: publishing is a metadata
 * decision, and accepting the flag here would let a stale client unpublish a
 * note just by writing to it.
 */
const saveNoteBody = noteNaming.extend({
	createdAt: timestampMs,
	content: blockDocument,
});

function timestamp(date: Date) {
	return date.getTime();
}

const mutationColumns = {
	createdAt: noteMutation.createdAt,
	content: noteMutation.content,
	delta: noteMutation.delta,
	baseCreatedAt: noteMutation.baseCreatedAt,
};

/**
 * The rows a reconstruction walks: the requested version plus newer ones, but
 * only up to the first stored snapshot at or above the target. A chain of
 * reverse deltas only ever points upward and stops at the first
 * content-bearing row it meets, so anything past that anchor is dead weight —
 * on a note edited for years, most of the history. When no snapshot bounds the
 * walk, the chain anchors at the note's current document and every newer row
 * rides along. Exported because the bound cannot be observed through HTTP.
 */
export async function reconstructionWindow(noteId: string, createdAt: Date) {
	return db
		.select(mutationColumns)
		.from(noteMutation)
		.where(
			and(
				eq(noteMutation.noteId, noteId),
				gte(noteMutation.createdAt, createdAt),
				sql`${noteMutation.createdAt} <= coalesce((
					select min(anchor.created_at)
					from ${noteMutation} as anchor
					where anchor.note_id = ${noteId}::uuid
						and anchor.created_at >= ${createdAt.toISOString()}::timestamp
						and anchor.content is not null
				), 'infinity'::timestamp)`,
			),
		)
		.orderBy(desc(noteMutation.createdAt));
}

/**
 * The remembered tag of `GET /notes`, so a poll that changed nothing costs one
 * Redis GET instead of reading every summary out of Neon. Every handler below
 * that writes the `note` or `note_mutation` tables drops it before responding.
 */
const indexCache = createIndexCache('notes');

export const notesRouter = new Elysia({ prefix: '/notes', tags: ['Notes'] })
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) =>
			indexCache.conditional(request, set, async () => {
				// Both timestamps live on the note itself, so listing needs no history.
				const notes = await db
					.select({
						id: note.id,
						title: note.title,
						path: note.path,
						isPublic: note.isPublic,
						createdAt: note.createdAt,
						updatedAt: note.updatedAt,
					})
					.from(note)
					.orderBy(note.path, note.title);

				return notes.map((item) => ({
					...item,
					createdAt: timestamp(item.createdAt),
					updatedAt: timestamp(item.updatedAt),
				}));
			}),
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
				.where(inFolder(note.path, body.from))
				.returning({ id: note.id });
			await indexCache.invalidate();

			return { updated: renamed.length };
		},
		{
			body: z.object({ from: noteFolderPath, to: noteFolderPath }),
			detail: { summary: 'Rename note folder' },
		},
	)
	.delete(
		'/folders',
		async ({ body }) => {
			const deleted = await db
				.delete(note)
				.where(inFolder(note.path, body.path))
				.returning({ id: note.id });
			await indexCache.invalidate();

			return { deleted: deleted.length };
		},
		{
			body: z.object({ path: noteFolderPath }),
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
				.returning({
					id: note.id,
					title: note.title,
					path: note.path,
					isPublic: note.isPublic,
				});
			await indexCache.invalidate();

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
					isPublic: note.isPublic,
					createdAt: note.createdAt,
					updatedAt: note.updatedAt,
					content: note.content,
				})
				.from(note)
				.where(eq(note.id, params.id))
				.limit(1);

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
			await indexCache.invalidate();
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
				.limit(1);

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
				.limit(query.limit + 1 - head.length);

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
				.limit(1);

			if (!head) return status(404, { error: 'NOTE_NOT_FOUND' });

			const rows = await reconstructionWindow(params.id, createdAt);

			// The target row itself is always inside the window, so existence can
			// be decided before reconstructing.
			const known =
				createdAt.getTime() === head.updatedAt.getTime() ||
				rows.some((row) => row.createdAt.getTime() === createdAt.getTime());
			if (!known) return status(404, { error: 'NOTE_MUTATION_NOT_FOUND' });

			let content = reconstructVersion(head, rows, createdAt);
			if (!content) {
				// An out-of-order snapshot can sit between two hops of the chain
				// without being on it, and the window — bounded by time, not by
				// pointers — then cuts the chain short. Rare enough to pay one
				// unbounded read instead of walking pointers in SQL.
				const everyRow = await db
					.select(mutationColumns)
					.from(noteMutation)
					.where(
						and(
							eq(noteMutation.noteId, params.id),
							gte(noteMutation.createdAt, createdAt),
						),
					)
					.orderBy(desc(noteMutation.createdAt));
				content = reconstructVersion(head, everyRow, createdAt);
			}
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
				isPublic: note.isPublic,
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
					.limit(1);

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

			// After every branch: each one ran at least an insert attempt.
			await indexCache.invalidate();

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
