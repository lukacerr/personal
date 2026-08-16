import { authPlugin } from '@api/auth';
import { cache, db, presigner, storage } from '@api/env';
import { deleteStoredFiles } from '@api/files-delete';
import {
	abortMultipartUpload,
	completeMultipartUpload,
	createMultipartUpload,
	listPendingUploads,
	presignParts,
	type UploadedPart,
} from '@api/files-multipart';
import {
	collectObjectIds,
	contentDisposition,
	MAX_FILE_SIZE,
	MAX_PARTS,
	MAX_PARTS_PER_REQUEST,
	MAX_UPLOADS_PER_REQUEST,
	nameKey,
	OBJECT_PREFIX,
	objectKey,
	planUpload,
	UPLOAD_TTL_SECONDS,
	uploadKey,
} from '@api/files-storage';
import { inFolder } from '@api/folder-paths';
import { createIndexCache } from '@api/http-cache';
import { file, note } from '@api/schema';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const fileId = z.uuid();

/**
 * A folder, as the endpoints that take one directly see it.
 *
 * The refinement lives here rather than on the nullable form below: `.unwrap()`
 * hands back the inner schema without the checks added afterwards, so deriving
 * this from a nullable parent would leave the folder endpoints validating
 * nothing but the length.
 */
const folderPath = z
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
		'Invalid file path',
	);

/** The folder a file sits in, where `null` is the root. */
const filePath = folderPath.nullable();

const fileName = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine(
		(name) =>
			!name.includes('/') &&
			!name.includes('\\') &&
			name !== '.' &&
			name !== '..' &&
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters have no place in a filename
			!/[\u0000-\u001F\u007F]/.test(name),
		'Invalid file name',
	);

const contentType = z
	.string()
	.trim()
	.min(1)
	.max(255)
	// Anchored, and with control characters excluded even inside the parameters:
	// this value comes back as a response header on every single download.
	.refine(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: excluding them is the point
		(value) => /^[\w.+-]+\/[\w.+-]+(;[^\u0000-\u001F\u007F]*)?$/.test(value),
		'Invalid content type',
	);

/** Bounded by what storage itself accepts, since the part plan is derived from it. */
const fileSize = z.number().int().positive().max(MAX_FILE_SIZE);

const uploadRequest = z.object({
	id: fileId,
	name: fileName,
	path: filePath,
	contentType,
	size: fileSize,
	/** Set by the Notes editor; the explorer leaves it alone. */
	uploadedFromNotes: z.boolean().default(false),
});

const fileMetadataBody = z.object({
	name: fileName,
	path: filePath,
	isPublic: z.boolean(),
});

const bulkIds = z
	.array(fileId)
	.min(1)
	.max(500)
	.refine((ids) => new Set(ids).size === ids.length, 'File ids must be unique');

const UPLOAD_URL_TTL_SECONDS = 6 * 60 * 60;
const LINK_TTL_SECONDS = 5 * 60;
const BULK_LINK_TTL_SECONDS = 30 * 60;

/**
 * An upload that has not finished. It lives in Redis under a TTL rather than as
 * a row, so the database only ever describes files that exist in storage.
 */
type PendingUpload = z.infer<typeof uploadRequest> & {
	uploadId?: string;
	partSize: number;
	partCount: number;
};

const fileColumns = {
	id: file.id,
	name: file.name,
	path: file.path,
	contentType: file.contentType,
	size: file.size,
	isPublic: file.isPublic,
	viewCount: file.viewCount,
	uploadedFromNotes: file.uploadedFromNotes,
	createdAt: file.createdAt,
	updatedAt: file.updatedAt,
};

type FileRow = {
	id: string;
	name: string;
	path: string | null;
	contentType: string;
	size: number;
	isPublic: boolean;
	viewCount: number;
	uploadedFromNotes: boolean;
	createdAt: Date;
	updatedAt: Date;
};

/**
 * Timestamps travel as epoch milliseconds, like every other system here.
 * Written against a concrete row rather than a generic on purpose: a generic
 * spread intersects the overridden fields into `Date & number`, which Eden then
 * hands to the client as a type nothing can satisfy.
 */
function serialize(row: FileRow) {
	return {
		...row,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

async function readPendingUpload(id: string) {
	return (await cache.get<PendingUpload>(uploadKey(id))) ?? undefined;
}

/** Releases both keys at once: the state and the name it was holding. */
async function releaseUpload(upload: PendingUpload) {
	await Promise.all([
		cache.del(uploadKey(upload.id)),
		cache.del(nameKey(upload.path, upload.name)),
	]);
}

async function deleteObject(id: string) {
	await storage.delete(objectKey(id));
}

/** Every id storage actually holds, paged through to the end of the bucket. */
async function listObjectIds() {
	return collectObjectIds((continuationToken) =>
		storage.list({ prefix: OBJECT_PREFIX, maxKeys: 1000, continuationToken }),
	);
}

/**
 * The remembered tag of `GET /files`, so the re-listing that follows every
 * upload, move, rename and delete costs one Redis GET when nothing changed
 * since. Every handler below that writes the `file` table — including
 * reconcile — drops it before responding; the upload reservations live in
 * Redis only and are not part of this payload.
 */
const indexCache = createIndexCache('storage');

export const filesRouter = new Elysia({ prefix: '/files', tags: ['Storage'] })
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) =>
			indexCache.conditional(request, set, async () => {
				// No filter: every row here has its object in storage by construction.
				const files = await db
					.select(fileColumns)
					.from(file)
					.orderBy(file.path, file.name);

				return files.map(serialize);
			}),
		{ detail: { summary: 'List stored files' } },
	)
	.get(
		// Declared before `/:id`: that route parses its parameter as a uuid, so
		// reaching it first would answer 422 rather than falling through to here.
		'/unreferenced',
		async () => {
			// Notes never deletes a file when its block goes away, so the only way
			// to find what is left over is to ask which ones nothing points at.
			//
			// The extraction runs in Postgres rather than here: `note.content` is
			// jsonb and a note may hold two megabytes, so pulling every document
			// into the API to walk it in JavaScript is exactly what to avoid.
			// `$.**` descends through the whole block tree, and `#>> '{}'` unwraps
			// the jsonb string into text so it can be compared to an id. In lax
			// mode that descent reports each match more than once, so the derived
			// table dedupes with `distinct`. Materialising the referenced ids once
			// lets the planner anti-join against them, instead of re-walking every
			// note's whole document for each candidate file.
			//
			// Only the current document of each note counts. History lives mostly
			// as jsondiffpatch deltas, where a removed file's id sits at a path
			// that depends on the diff rather than on the schema.
			const files = await db
				.select(fileColumns)
				.from(file)
				.where(
					and(
						eq(file.uploadedFromNotes, true),
						sql`not exists (
							select 1
							from (
								select distinct ref #>> '{}' as file_id
								from ${note}, jsonb_path_query(${note.content}, '$.**.props.fileId') as ref
							) as refs
							where refs.file_id = ${file.id}::text
						)`,
					),
				)
				.orderBy(desc(file.createdAt));

			return files.map(serialize);
		},
		{ detail: { summary: 'List Notes uploads no note references' } },
	)
	.post(
		'/uploads',
		async ({ body }) => {
			// The advisory pre-check for every name travels as one SELECT rather
			// than one per file: each pair keeps the `lower(coalesce(path, ''))` /
			// `lower(name)` shape so the unique index still serves it, and the OR
			// preserves a result per file. Advisory only — the NX claim below is
			// what actually arbitrates a race.
			// NUL-joined: neither part can contain it, so keys cannot collide.
			const takenName = (path: string | null, name: string) =>
				`${(path ?? '').toLowerCase()}\u0000${name.toLowerCase()}`;
			const stored = await db
				.select({ path: file.path, name: file.name })
				.from(file)
				.where(
					or(
						...body.files.map((request) =>
							and(
								sql`lower(coalesce(${file.path}, '')) = lower(${request.path ?? ''})`,
								sql`lower(${file.name}) = lower(${request.name})`,
							),
						),
					),
				);
			const takenNames = new Set(
				stored.map((row) => takenName(row.path, row.name)),
			);

			// One request for a whole selection, and one result per file: a name
			// clash on the third file cannot take the other five down with it.
			const results = await Promise.all(
				body.files.map(async (request) => {
					if (takenNames.has(takenName(request.path, request.name)))
						return { id: request.id, status: 'rejected', error: 'NAME_TAKEN' };

					// Claiming the name up front is what stops two concurrent uploads
					// of the same name from both transferring everything and only
					// colliding at the very end.
					const claimed = await cache.set(
						nameKey(request.path, request.name),
						request.id,
						{ nx: true, ex: UPLOAD_TTL_SECONDS },
					);
					if (claimed !== 'OK')
						return { id: request.id, status: 'rejected', error: 'NAME_TAKEN' };

					const plan = planUpload(request.size);
					const pending: PendingUpload = {
						...request,
						partSize: plan.partSize,
						partCount: plan.partCount,
					};

					// The reservation is written before the multipart upload is opened,
					// never after. Reconciliation reads a multipart upload with no
					// reservation as unreachable, and opening one first would leave a
					// window where a perfectly healthy upload looks abandoned.
					await cache.set(uploadKey(request.id), pending, {
						ex: UPLOAD_TTL_SECONDS,
					});

					if (plan.mode === 'multipart') {
						try {
							pending.uploadId = await createMultipartUpload(
								request.id,
								request.contentType,
							);
						} catch {
							// One file storage refused cannot take the batch down with it,
							// and its name has to go back immediately: left held, nothing
							// could retry that name for a day.
							await releaseUpload(pending);
							return {
								id: request.id,
								status: 'rejected',
								error: 'UPLOAD_UNAVAILABLE',
							};
						}
						await cache.set(uploadKey(request.id), pending, {
							ex: UPLOAD_TTL_SECONDS,
						});
					}

					return {
						id: request.id,
						status: 'ready',
						mode: plan.mode,
						partSize: plan.partSize,
						partCount: plan.partCount,
						...(plan.mode === 'single'
							? {
									url: presigner.presign(objectKey(request.id), {
										method: 'PUT',
										expiresIn: UPLOAD_URL_TTL_SECONDS,
										type: request.contentType,
									}),
								}
							: {}),
					};
				}),
			);

			return { results };
		},
		{
			body: z.object({
				files: z.array(uploadRequest).min(1).max(MAX_UPLOADS_PER_REQUEST),
			}),
			detail: { summary: 'Reserve uploads' },
		},
	)
	.post(
		'/:id/parts',
		async ({ body, params }) => {
			const upload = await readPendingUpload(params.id);
			if (!upload?.uploadId) return status(410, { error: 'UPLOAD_EXPIRED' });

			if (body.partNumbers.some((part) => part > upload.partCount))
				return status(422, { error: 'PART_OUT_OF_RANGE' });

			// Sliding expiration: an upload that keeps moving keeps its reservation.
			await Promise.all([
				cache.expire(uploadKey(upload.id), UPLOAD_TTL_SECONDS),
				cache.expire(nameKey(upload.path, upload.name), UPLOAD_TTL_SECONDS),
			]);

			return {
				parts: await presignParts(
					upload.id,
					upload.uploadId,
					body.partNumbers,
					UPLOAD_URL_TTL_SECONDS,
				),
			};
		},
		{
			params: z.object({ id: fileId }),
			body: z.object({
				partNumbers: z
					.array(z.number().int().min(1).max(MAX_PARTS))
					.min(1)
					.max(MAX_PARTS_PER_REQUEST),
			}),
			detail: { summary: 'Sign a batch of upload parts' },
		},
	)
	.post(
		'/:id/complete',
		async ({ body, params }) => {
			const upload = await readPendingUpload(params.id);
			// Without the reservation there is no upload id and no destination
			// name, and guessing either one would be inventing data.
			if (!upload) return status(410, { error: 'UPLOAD_EXPIRED' });

			if (upload.uploadId) {
				const completion = await completeMultipartUpload(
					upload.id,
					upload.uploadId,
					body.parts ?? [],
				);
				if (!completion.ok) {
					await abortMultipartUpload(upload.id, upload.uploadId);
					await releaseUpload(upload);
					return status(409, { error: 'UPLOAD_INCOMPLETE' });
				}
			}

			// The size is read from storage rather than trusted from the client:
			// the row is only meaningful if it describes what the bucket holds.
			const stat = await storage
				.stat(objectKey(upload.id))
				.catch(() => undefined);

			if (!stat) {
				if (upload.uploadId)
					await abortMultipartUpload(upload.id, upload.uploadId);
				await releaseUpload(upload);
				return status(409, { error: 'FILE_NOT_UPLOADED' });
			}

			try {
				// The single write to the database, and it happens only once the
				// object is known to be complete. A conflict on the id is swallowed
				// rather than caught: it means a concurrent or retried complete
				// already wrote this very row, which is success, not garbage.
				const [created] = await db
					.insert(file)
					.values({
						id: upload.id,
						name: upload.name,
						path: upload.path,
						contentType: upload.contentType,
						size: stat.size,
						uploadedFromNotes: upload.uploadedFromNotes,
					})
					.onConflictDoNothing({ target: file.id })
					.returning(fileColumns);
				await indexCache.invalidate();

				if (created) {
					await releaseUpload(upload);
					return status(201, serialize(created));
				}
			} catch (error) {
				// Someone took the name between the reservation and now. An object
				// with no row is silent garbage, so it goes before the error does.
				await deleteObject(upload.id);
				await releaseUpload(upload);
				throw error;
			}

			// The row already exists under this id: answer with it. Deleting the
			// object here — as the name-conflict path does — would leave the
			// winner's row pointing at nothing.
			const [existing] = await db
				.select(fileColumns)
				.from(file)
				.where(eq(file.id, upload.id))
				.limit(1);

			if (!existing) throw new Error('Insert returned no row');
			await releaseUpload(upload);
			return status(201, serialize(existing));
		},
		{
			params: z.object({ id: fileId }),
			body: z.object({
				parts: z
					.array(
						z.object({
							partNumber: z.number().int().min(1).max(MAX_PARTS),
							etag: z.string().min(1).max(255),
						}),
					)
					.max(MAX_PARTS)
					.optional(),
			}),
			detail: { summary: 'Confirm an upload' },
		},
	)
	.post(
		'/reconcile',
		async () => {
			const [rows, stored, pending] = await Promise.all([
				db.select({ id: file.id }).from(file),
				listObjectIds(),
				listPendingUploads(),
			]);

			const known = new Set(rows.map((row) => row.id));
			const objects = new Set(stored);

			// An object no row claims is an upload whose confirmation never
			// arrived, or a file put there from outside the app. An upload still
			// holding its reservation is neither: between the presigned PUT and
			// `complete` the object exists and the row does not, on purpose, and
			// deleting it would erase a transfer that is going perfectly well.
			const deletedObjects = (
				await Promise.all(
					stored
						.filter((id) => !known.has(id))
						.map(async (id) =>
							(await cache.exists(uploadKey(id))) === 0 ? id : [],
						),
				)
			).flat();
			// A row with no object is a file the UI would show and fail to open.
			const deletedRows = rows
				.filter((row) => !objects.has(row.id))
				.map((row) => row.id);

			// A multipart upload with no reservation left can never be finished:
			// nothing remembers its id anymore. Its parts keep costing storage and
			// are invisible to any object listing, so this is the only way back.
			const abandoned = (
				await Promise.all(
					pending.map(async (upload) =>
						(await cache.exists(uploadKey(upload.id))) === 0 ? upload : [],
					),
				)
			).flat();

			await Promise.all([
				...deletedObjects.map((id) => deleteObject(id)),
				...abandoned.map((upload) =>
					abortMultipartUpload(upload.id, upload.uploadId),
				),
			]);
			if (deletedRows.length > 0) {
				await db.delete(file).where(inArray(file.id, deletedRows));
				await indexCache.invalidate();
			}

			return {
				deletedObjects,
				deletedRows,
				abortedUploads: abandoned.map((upload) => upload.id),
			};
		},
		{ detail: { summary: 'Reconcile storage against the database' } },
	)
	.patch(
		'/bulk/move',
		async ({ body }) => {
			const requested = inArray(file.id, body.ids);
			// The count guard lives inside the UPDATE statement. If even one id is
			// missing, the predicate is false for every row and nothing moves.
			const moved = await db
				.update(file)
				.set({ path: body.path })
				.where(
					and(
						requested,
						sql`(select count(*) from ${file} where ${requested}) = ${body.ids.length}`,
					),
				)
				.returning(fileColumns);
			await indexCache.invalidate();

			if (moved.length !== body.ids.length)
				return status(404, { error: 'FILES_NOT_FOUND' });

			const byId = new Map(moved.map((entry) => [entry.id, entry]));
			return body.ids.map((id) => {
				const entry = byId.get(id);
				if (!entry) throw new Error(`Bulk move lost ${id}`);
				return serialize(entry);
			});
		},
		{
			body: z.object({ ids: bulkIds, path: filePath }),
			detail: { summary: 'Move several files atomically' },
		},
	)
	.post(
		'/bulk/links',
		async ({ body }) => {
			const rows = await db
				.select(fileColumns)
				.from(file)
				.where(inArray(file.id, body.ids));
			if (rows.length !== body.ids.length)
				return status(404, { error: 'FILES_NOT_FOUND' });

			const byId = new Map(rows.map((entry) => [entry.id, entry]));
			const expiresAt = Date.now() + BULK_LINK_TTL_SECONDS * 1000;
			return body.ids.map((id) => {
				const entry = byId.get(id);
				if (!entry) throw new Error(`Bulk link manifest lost ${id}`);
				return {
					...serialize(entry),
					url: presigner.presign(objectKey(id), {
						method: 'GET',
						expiresIn: BULK_LINK_TTL_SECONDS,
						type: entry.contentType,
						contentDisposition: contentDisposition('attachment', entry.name),
					}),
					expiresAt,
				};
			});
		},
		{
			body: z.object({ ids: bulkIds }),
			detail: { summary: 'Get temporary links for several files' },
		},
	)
	.post(
		'/bulk/delete',
		async ({ body }) => {
			const existing = await db
				.select({ id: file.id })
				.from(file)
				.where(inArray(file.id, body.ids));
			const existingIds = new Set(existing.map((entry) => entry.id));
			const result = await deleteStoredFiles(
				body.ids.filter((id) => existingIds.has(id)),
				{
					deleteObject,
					deleteRow: async (id) => {
						await db.delete(file).where(eq(file.id, id));
					},
				},
			);
			await indexCache.invalidate();
			const deleted = new Set([
				...result.deleted,
				...body.ids.filter((id) => !existingIds.has(id)),
			]);

			return {
				deleted: body.ids.filter((id) => deleted.has(id)),
				failed: result.failed,
			};
		},
		{
			body: z.object({ ids: bulkIds }),
			detail: { summary: 'Delete several files' },
		},
	)
	.patch(
		'/folders',
		async ({ body }) => {
			// A pure update: the storage key never depended on the path, so moving
			// a folder of five hundred files touches storage not at all.
			const renamed = await db
				.update(file)
				.set({
					path: sql<string>`${body.to} || substr(${file.path}, char_length(${body.from}) + 1)`,
				})
				.where(inFolder(file.path, body.from))
				.returning({ id: file.id });
			await indexCache.invalidate();

			return { updated: renamed.length };
		},
		{
			body: z.object({ from: folderPath, to: folderPath }),
			detail: { summary: 'Rename a folder' },
		},
	)
	.delete(
		'/folders',
		async ({ body }) => {
			const targets = await db
				.select({ id: file.id })
				.from(file)
				.where(inFolder(file.path, body.path));
			const result = await deleteStoredFiles(
				targets.map((entry) => entry.id),
				{
					deleteObject,
					deleteRow: async (id) => {
						await db.delete(file).where(eq(file.id, id));
					},
				},
			);
			await indexCache.invalidate();

			return { deleted: result.deleted.length, failed: result.failed };
		},
		{
			body: z.object({ path: folderPath }),
			detail: { summary: 'Delete a folder' },
		},
	)
	.get(
		'/:id',
		async ({ params }) => {
			const [result] = await db
				.select(fileColumns)
				.from(file)
				.where(eq(file.id, params.id))
				.limit(1);

			if (!result) return status(404, { error: 'FILE_NOT_FOUND' });
			return serialize(result);
		},
		{
			params: z.object({ id: fileId }),
			detail: { summary: 'Get file metadata' },
		},
	)
	.get(
		'/:id/link',
		async ({ params, query }) => {
			const [result] = await db
				.select({ name: file.name, contentType: file.contentType })
				.from(file)
				.where(eq(file.id, params.id))
				.limit(1);

			if (!result) return status(404, { error: 'FILE_NOT_FOUND' });

			// The key is an opaque uuid, so without this every download would be
			// named after the id rather than after the file.
			const url = presigner.presign(objectKey(params.id), {
				method: 'GET',
				expiresIn: LINK_TTL_SECONDS,
				type: result.contentType,
				contentDisposition: contentDisposition(query.disposition, result.name),
			});

			return { url, expiresAt: Date.now() + LINK_TTL_SECONDS * 1000 };
		},
		{
			params: z.object({ id: fileId }),
			query: z.object({
				disposition: z.enum(['inline', 'attachment']).default('inline'),
			}),
			detail: { summary: 'Get a temporary download link' },
		},
	)
	.patch(
		'/:id',
		async ({ body, params }) => {
			const [updated] = await db
				.update(file)
				.set(body)
				.where(eq(file.id, params.id))
				.returning(fileColumns);
			await indexCache.invalidate();

			if (!updated) return status(404, { error: 'FILE_NOT_FOUND' });
			return serialize(updated);
		},
		{
			params: z.object({ id: fileId }),
			body: fileMetadataBody,
			detail: { summary: 'Update file metadata' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			// The same id can name either a stored file or an upload still running,
			// and cancelling one is the same gesture as deleting the other.
			const upload = await readPendingUpload(params.id);
			if (upload) {
				if (upload.uploadId)
					await abortMultipartUpload(upload.id, upload.uploadId);
				await deleteObject(upload.id);
				await releaseUpload(upload);
			}

			// Storage first: the row is the only record that the object exists, so
			// dropping it before the object leaves debris nobody can find.
			const [existing] = await db
				.select({ id: file.id })
				.from(file)
				.where(eq(file.id, params.id))
				.limit(1);
			if (existing) {
				const result = await deleteStoredFiles([params.id], {
					deleteObject,
					deleteRow: async (id) => {
						await db.delete(file).where(eq(file.id, id));
					},
				});
				await indexCache.invalidate();
				if (result.failed.length > 0)
					return status(503, { error: result.failed[0]?.error });
			}

			return status(204);
		},
		{
			params: z.object({ id: fileId }),
			detail: { summary: 'Delete a file or cancel its upload' },
		},
	);

export type { UploadedPart };
