import { afterEach, describe, expect, it } from 'bun:test';
import { cache, db, storage } from '@api/env';
import { nameKey, objectKey, uploadKey } from '@api/files-storage';
import { file, note } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';
import { json, request } from './helpers';

const touchedIds = new Set<string>();
const noteIds = new Set<string>();

type Reservation = {
	id: string;
	status: 'ready' | 'rejected';
	mode?: 'single' | 'multipart';
	partSize?: number;
	partCount?: number;
	url?: string;
	error?: string;
};

async function reserve(
	files: Array<{
		id?: string;
		name?: string;
		path?: string | null;
		contentType?: string;
		size?: number;
		uploadedFromNotes?: boolean;
	}>,
) {
	const payload = files.map((entry) => {
		const id = entry.id ?? randomUUIDv7();
		touchedIds.add(id);
		return {
			id,
			name: entry.name ?? 'report.pdf',
			path: entry.path === undefined ? 'work' : entry.path,
			contentType: entry.contentType ?? 'application/pdf',
			size: entry.size ?? 12,
			...(entry.uploadedFromNotes === undefined
				? {}
				: { uploadedFromNotes: entry.uploadedFromNotes }),
		};
	});
	const response = await json('/files/uploads', 'POST', { files: payload });
	return {
		response,
		payload,
		results: (await response.json()) as { results: Reservation[] },
	};
}

/** The whole point of a presigned URL: the bytes never pass through the API. */
async function put(url: string, body: string, contentType: string) {
	return fetch(url, {
		method: 'PUT',
		headers: { 'content-type': contentType },
		body,
	});
}

async function uploadSingle({
	name = 'report.pdf',
	path = 'work' as string | null,
	contentType = 'text/plain',
	body = 'hello storage',
	uploadedFromNotes = undefined as boolean | undefined,
} = {}) {
	const { results } = await reserve([
		{ name, path, contentType, size: body.length, uploadedFromNotes },
	]);
	const [reservation] = results.results;
	if (!reservation?.url) throw new Error('Expected a presigned upload URL');

	await put(reservation.url, body, contentType);
	const completed = await json(`/files/${reservation.id}/complete`, 'POST', {});
	return { id: reservation.id, completed, body, name, path, contentType };
}

/**
 * A note whose document references the given file ids through the block prop
 * the editor writes. Only the shape matters here: the API stores the document
 * as opaque JSON and never reads a block's type.
 */
async function saveNoteReferencing(fileIds: string[]) {
	const id = randomUUIDv7();
	noteIds.add(id);
	const response = await json(`/notes/${id}/mutations`, 'POST', {
		title: `Note ${id.slice(0, 8)}`,
		path: null,
		createdAt: Date.now(),
		content: [
			{
				id: randomUUIDv7(),
				type: 'paragraph',
				props: {},
				content: [],
				children: [],
			},
			...fileIds.map((fileId) => ({
				id: randomUUIDv7(),
				type: 'storedFile',
				props: { fileId, name: 'attached.txt', contentType: 'text/plain' },
				children: [],
			})),
		],
	});
	if (response.status !== 201)
		throw new Error(`Expected the note to save, got ${response.status}`);
	return id;
}

afterEach(async () => {
	const notes = [...noteIds];
	noteIds.clear();
	if (notes.length > 0) await db.delete(note).where(inArray(note.id, notes));

	const ids = [...touchedIds];
	touchedIds.clear();
	if (ids.length === 0) return;

	await db.delete(file).where(inArray(file.id, ids));
	await Promise.all(
		ids.flatMap((id) => [
			storage.delete(objectKey(id)).catch(() => undefined),
			cache.del(uploadKey(id)),
		]),
	);
	// Name reservations are keyed by name, not id, so they are swept separately.
	const keys = await cache.keys('storage:name:*');
	if (keys.length > 0) await cache.del(...keys);
});

describe('File uploads', () => {
	/**
	 * The invariant the whole design rests on: until storage confirms the object,
	 * the database knows nothing about it. Every read of `file` can therefore
	 * trust that the object behind the row exists.
	 */
	it('writes nothing to the database when reserving an upload', async () => {
		const { response, results, payload } = await reserve([{ size: 4 }]);

		expect(response.status).toBe(200);
		expect(results.results[0]).toMatchObject({ status: 'ready' });
		expect((await (await request('/files')).json()) as unknown[]).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: payload[0]?.id })]),
		);
		expect(
			await db.$count(file, inArray(file.id, [payload[0]?.id ?? ''])),
		).toBe(0);
	});

	it('stores a small file through one presigned PUT', async () => {
		const uploaded = await uploadSingle();

		expect(uploaded.completed.status).toBe(201);
		expect(await uploaded.completed.json()).toMatchObject({
			id: uploaded.id,
			name: 'report.pdf',
			path: 'work',
			contentType: 'text/plain',
			size: uploaded.body.length,
			isPublic: false,
		});
		expect(await storage.file(objectKey(uploaded.id)).text()).toBe(
			uploaded.body,
		);
	});

	it('records the size storage reports instead of the one declared', async () => {
		const body = 'the real bytes';
		const { results } = await reserve([
			{ contentType: 'text/plain', size: 999_999 },
		]);
		const [reservation] = results.results;
		if (!reservation?.url) throw new Error('Expected a presigned upload URL');

		await put(reservation.url, body, 'text/plain');
		const completed = await json(
			`/files/${reservation.id}/complete`,
			'POST',
			{},
		);

		expect(await completed.json()).toMatchObject({ size: body.length });
	});

	it('creates no row when the object never arrived', async () => {
		const { results } = await reserve([{ size: 4 }]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		const completed = await json(
			`/files/${reservation.id}/complete`,
			'POST',
			{},
		);

		expect(completed.status).toBe(409);
		expect(await db.$count(file, inArray(file.id, [reservation.id]))).toBe(0);
		// The failed reservation also stops holding its name.
		expect(await cache.get(nameKey('work', 'report.pdf'))).toBeNull();
	});

	it('reports an upload whose reservation is gone as expired', async () => {
		const { results } = await reserve([{ size: 4 }]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');
		await cache.del(uploadKey(reservation.id));

		const completed = await json(
			`/files/${reservation.id}/complete`,
			'POST',
			{},
		);

		expect(completed.status).toBe(410);
	});

	it('rejects a second upload of a name already being uploaded', async () => {
		const first = await reserve([{ name: 'clash.txt', path: 'work' }]);
		const second = await reserve([{ name: 'CLASH.TXT', path: 'WORK' }]);

		expect(first.results.results[0]?.status).toBe('ready');
		expect(second.results.results[0]).toMatchObject({
			status: 'rejected',
			error: 'NAME_TAKEN',
		});
	});

	it('rejects an upload of a name an existing file already uses', async () => {
		const uploaded = await uploadSingle({ name: 'taken.txt', path: 'work' });
		const { results } = await reserve([{ name: 'TAKEN.txt', path: 'work' }]);

		expect(uploaded.completed.status).toBe(201);
		expect(results.results[0]).toMatchObject({
			status: 'rejected',
			error: 'NAME_TAKEN',
		});
	});

	it('reserves the rest of a batch when one entry is rejected', async () => {
		await uploadSingle({ name: 'occupied.txt', path: 'batch' });

		const { results } = await reserve([
			{ name: 'first.txt', path: 'batch' },
			{ name: 'occupied.txt', path: 'batch' },
			{ name: 'third.txt', path: 'batch' },
		]);

		expect(results.results.map((entry) => entry.status)).toEqual([
			'ready',
			'rejected',
			'ready',
		]);
	});

	it('frees the name as soon as an upload in progress is cancelled', async () => {
		const first = await reserve([{ name: 'retry.txt', path: 'work' }]);
		const cancelled = await request(`/files/${first.results.results[0]?.id}`, {
			method: 'DELETE',
		});
		const second = await reserve([{ name: 'retry.txt', path: 'work' }]);

		expect(cancelled.status).toBe(204);
		expect(second.results.results[0]?.status).toBe('ready');
	});
});

type ReconcileReport = {
	deletedObjects: string[];
	deletedRows: string[];
	abortedUploads: string[];
};

describe('Reconciliation', () => {
	/**
	 * The place where "the database is the source of truth" stops being an
	 * assumption and becomes something that can be checked.
	 */
	it('removes an object no row claims', async () => {
		const orphan = randomUUIDv7();
		touchedIds.add(orphan);
		await storage.write(objectKey(orphan), 'left behind');

		const response = await json('/files/reconcile', 'POST', {});
		const report = (await response.json()) as ReconcileReport;

		expect(response.status).toBe(200);
		expect(report.deletedObjects).toContain(orphan);
		expect(await storage.exists(objectKey(orphan))).toBe(false);
	});

	it('removes a row whose object is gone', async () => {
		const uploaded = await uploadSingle({ name: 'vanished.txt', path: 'work' });
		// Simulates the object being deleted outside the app.
		await storage.delete(objectKey(uploaded.id));

		const response = await json('/files/reconcile', 'POST', {});
		const report = (await response.json()) as ReconcileReport;

		expect(report.deletedRows).toContain(uploaded.id);
		expect((await request(`/files/${uploaded.id}`)).status).toBe(404);
	});

	/**
	 * Between the presigned PUT and `complete` the object exists and its row does
	 * not, by design. Reading that as garbage deletes a transfer that is going
	 * perfectly well, and the user only finds out when confirming it fails.
	 */
	it('leaves the object of an upload that was not confirmed yet', async () => {
		const { results } = await reserve([
			{ name: 'inflight.txt', contentType: 'text/plain', size: 5 },
		]);
		const [reservation] = results.results;
		if (!reservation?.url) throw new Error('Expected a presigned upload URL');
		await put(reservation.url, 'hello', 'text/plain');

		const response = await json('/files/reconcile', 'POST', {});
		const report = (await response.json()) as ReconcileReport;
		const completed = await json(
			`/files/${reservation.id}/complete`,
			'POST',
			{},
		);

		expect(report.deletedObjects).not.toContain(reservation.id);
		expect(completed.status).toBe(201);
	});

	it('leaves an upload that is still in progress alone', async () => {
		const { results } = await reserve([
			{
				name: 'running.bin',
				contentType: 'application/octet-stream',
				size: 9 * MIB,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		const response = await json('/files/reconcile', 'POST', {});
		const report = (await response.json()) as ReconcileReport;

		expect(report.abortedUploads).not.toContain(reservation.id);
	});

	/**
	 * The case that justifies the endpoint: abandoned parts never appear in a
	 * bucket listing and keep costing storage, and once the reservation expires
	 * nothing else remembers the upload id.
	 */
	it('aborts a multipart upload nothing is claiming anymore', async () => {
		const { results } = await reserve([
			{
				name: 'abandoned.bin',
				contentType: 'application/octet-stream',
				size: 9 * MIB,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');
		// The reservation expiring is what makes the upload unreachable.
		await cache.del(uploadKey(reservation.id));

		const response = await json('/files/reconcile', 'POST', {});
		const report = (await response.json()) as ReconcileReport;

		expect(report.abortedUploads).toContain(reservation.id);
	});
});

describe('File folders', () => {
	it('renames only the requested folder prefix', async () => {
		const direct = await uploadSingle({ name: 'direct.txt', path: 'work' });
		const nested = await uploadSingle({
			name: 'nested.txt',
			path: 'work/projects',
		});
		const neighbor = await uploadSingle({
			name: 'neighbor.txt',
			path: 'workbench',
		});

		const response = await json('/files/folders', 'PATCH', {
			from: 'WORK',
			to: 'archive/work',
		});
		const listed = (await (await request('/files')).json()) as Array<{
			id: string;
			path: string | null;
		}>;
		const pathOf = (id: string) => listed.find((item) => item.id === id)?.path;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ updated: 2 });
		expect(pathOf(direct.id)).toBe('archive/work');
		expect(pathOf(nested.id)).toBe('archive/work/projects');
		expect(pathOf(neighbor.id)).toBe('workbench');
	});

	/**
	 * A folder is user input reaching a `LIKE`, where `_` matches any character.
	 * Unescaped, renaming `plan_a` would quietly rename `planXa` alongside it.
	 */
	it('treats folder wildcards as literal characters', async () => {
		const target = await uploadSingle({ name: 'a.txt', path: 'plan_a/deep' });
		const neighbor = await uploadSingle({ name: 'b.txt', path: 'planXa/deep' });
		const unrelated = await uploadSingle({ name: 'c.txt', path: 'other' });

		const renamed = await json('/files/folders', 'PATCH', {
			from: 'plan_a',
			to: 'archive',
		});
		const wildcard = await json('/files/folders', 'DELETE', { path: '%' });
		const listed = (await (await request('/files')).json()) as Array<{
			id: string;
			path: string | null;
		}>;
		const pathOf = (id: string) => listed.find((item) => item.id === id)?.path;

		expect(await renamed.json()).toEqual({ updated: 1 });
		expect(await wildcard.json()).toEqual({ deleted: 0, failed: [] });
		expect(pathOf(target.id)).toBe('archive/deep');
		expect(pathOf(neighbor.id)).toBe('planXa/deep');
		expect(pathOf(unrelated.id)).toBe('other');
	});

	/**
	 * A folder endpoint takes the same kind of path a file does, and has to
	 * reject the same things. Sharing a schema is not enough on its own: a
	 * nullable schema unwrapped back to a string quietly leaves its refinements
	 * behind, and the endpoint ends up validating only the length.
	 */
	it.each([
		['a leading slash', '/work'],
		['a trailing slash', 'work/'],
		['a parent reference', '../secrets'],
		['an empty segment', 'work//deep'],
		['nothing at all', ''],
	])('refuses a folder path with %s', async (_case, path) => {
		const renamed = await json('/files/folders', 'PATCH', {
			from: path,
			to: 'archive',
		});
		const deleted = await json('/files/folders', 'DELETE', { path });

		expect(renamed.status).toBe(422);
		expect(deleted.status).toBe(422);
	});

	it('deletes a folder recursively, objects included', async () => {
		const inside = await uploadSingle({
			name: 'inside.txt',
			path: 'trash/sub',
		});
		const sibling = await uploadSingle({ name: 'kept.txt', path: 'trashcan' });

		const response = await json('/files/folders', 'DELETE', { path: 'trash' });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: 1, failed: [] });
		expect((await request(`/files/${inside.id}`)).status).toBe(404);
		expect(await storage.exists(objectKey(inside.id))).toBe(false);
		expect((await request(`/files/${sibling.id}`)).status).toBe(200);
		expect(await storage.exists(objectKey(sibling.id))).toBe(true);
	});
});

const MIB = 1024 * 1024;

describe('Multipart uploads', () => {
	/**
	 * The end-to-end proof that presigned multipart works: the API only ever
	 * signs and confirms, every byte travels from here straight to storage, and
	 * what comes back has to be the same file that went up.
	 */
	it('uploads a large file in parts and reassembles it exactly', async () => {
		const content = new Uint8Array(9 * MIB);
		for (let index = 0; index < content.length; index += 1)
			content[index] = index % 251;

		const { results } = await reserve([
			{
				name: 'big.bin',
				contentType: 'application/octet-stream',
				size: content.length,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		expect(reservation.mode).toBe('multipart');
		expect(reservation.partCount).toBe(2);
		// A multipart upload is signed per part, never as one URL.
		expect(reservation.url).toBeUndefined();

		const partSize = reservation.partSize ?? 0;
		const signed = await json(`/files/${reservation.id}/parts`, 'POST', {
			partNumbers: [1, 2],
		});
		const { parts } = (await signed.json()) as {
			parts: Array<{ partNumber: number; url: string }>;
		};

		const uploaded = await Promise.all(
			parts.map(async ({ partNumber, url }) => {
				const chunk = content.slice(
					(partNumber - 1) * partSize,
					partNumber * partSize,
				);
				const response = await fetch(url, { method: 'PUT', body: chunk });
				const etag = response.headers.get('etag');
				if (!etag)
					throw new Error(`Storage returned no ETag for part ${partNumber}`);
				return { partNumber, etag };
			}),
		);

		const completed = await json(`/files/${reservation.id}/complete`, 'POST', {
			parts: uploaded,
		});
		const stored = new Uint8Array(
			await storage.file(objectKey(reservation.id)).arrayBuffer(),
		);

		expect(completed.status).toBe(201);
		expect(await completed.json()).toMatchObject({ size: content.length });
		expect(stored).toEqual(content);
	});

	it('creates no row when a part is completed with the wrong etag', async () => {
		const content = new Uint8Array(9 * MIB).fill(7);
		const { results } = await reserve([
			{
				name: 'corrupt.bin',
				contentType: 'application/octet-stream',
				size: content.length,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		const signed = await json(`/files/${reservation.id}/parts`, 'POST', {
			partNumbers: [1, 2],
		});
		const { parts } = (await signed.json()) as {
			parts: Array<{ partNumber: number; url: string }>;
		};
		const partSize = reservation.partSize ?? 0;
		for (const { partNumber, url } of parts)
			await fetch(url, {
				method: 'PUT',
				body: content.slice((partNumber - 1) * partSize, partNumber * partSize),
			});

		const completed = await json(`/files/${reservation.id}/complete`, 'POST', {
			parts: [
				{ partNumber: 1, etag: '"0000000000000000000000000000ffff"' },
				{ partNumber: 2, etag: '"0000000000000000000000000000eeee"' },
			],
		});

		expect(completed.status).toBe(409);
		expect(await db.$count(file, inArray(file.id, [reservation.id]))).toBe(0);
	});

	it('keeps the reservation alive while parts are still being signed', async () => {
		const { results } = await reserve([
			{
				name: 'slow.bin',
				contentType: 'application/octet-stream',
				size: 9 * MIB,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		await cache.expire(uploadKey(reservation.id), 60);
		await json(`/files/${reservation.id}/parts`, 'POST', { partNumbers: [1] });

		// Sliding expiration: an upload that keeps moving keeps its reservation,
		// so an hours-long transfer is never cut off halfway through.
		expect(await cache.ttl(uploadKey(reservation.id))).toBeGreaterThan(60);
	});

	it('refuses to sign a part beyond the planned count', async () => {
		const { results } = await reserve([
			{
				name: 'bounded.bin',
				contentType: 'application/octet-stream',
				size: 9 * MIB,
			},
		]);
		const [reservation] = results.results;
		if (!reservation) throw new Error('Expected a reservation');

		const response = await json(`/files/${reservation.id}/parts`, 'POST', {
			partNumbers: [3],
		});

		expect(response.status).toBe(422);
	});
});

describe('Files', () => {
	it('lists stored files with numeric timestamps', async () => {
		const uploaded = await uploadSingle({ name: 'listed.txt', path: 'work' });

		const response = await request('/files');
		const listed = (await response.json()) as Array<{
			id: string;
			createdAt: number;
			updatedAt: number;
		}>;
		const entry = listed.find((item) => item.id === uploaded.id);

		expect(response.status).toBe(200);
		expect(entry).toMatchObject({ name: 'listed.txt', path: 'work' });
		expect(typeof entry?.createdAt).toBe('number');
		expect(typeof entry?.updatedAt).toBe('number');
	});

	/**
	 * Every upload, move, rename and delete asks for this list again, so the
	 * repeat is the common case. A client holding the same answer is told so
	 * rather than being sent it twice.
	 */
	it('answers a repeated listing with nothing to download', async () => {
		await uploadSingle({ name: 'listed-again.txt', path: 'work' });

		const first = await request('/files');
		const tag = first.headers.get('etag');
		if (!tag) throw new Error('Expected the listing to carry an entity tag');
		const repeated = await request('/files', {
			headers: { 'if-none-match': tag },
		});

		expect(first.status).toBe(200);
		expect(repeated.status).toBe(304);
		expect(await repeated.text()).toBe('');
	});

	it('answers 404 for a file that does not exist', async () => {
		expect((await request(`/files/${randomUUIDv7()}`)).status).toBe(404);
	});

	it('hands out a working download link carrying the real filename', async () => {
		const uploaded = await uploadSingle({
			name: 'año informe.txt',
			path: null,
			body: 'downloadable',
		});

		const response = await request(
			`/files/${uploaded.id}/link?disposition=attachment`,
		);
		const { url } = (await response.json()) as { url: string };
		const downloaded = await fetch(url);

		expect(response.status).toBe(200);
		expect(await downloaded.text()).toBe('downloadable');
		expect(downloaded.headers.get('content-disposition')).toContain(
			`filename*=UTF-8''a%C3%B1o%20informe.txt`,
		);
	});

	it('renames and moves without touching the object', async () => {
		const uploaded = await uploadSingle({ name: 'before.txt', path: 'work' });

		const patched = await json(`/files/${uploaded.id}`, 'PATCH', {
			name: 'after.txt',
			path: 'archive/2026',
			isPublic: true,
		});

		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			name: 'after.txt',
			path: 'archive/2026',
			isPublic: true,
		});
		// Same key, same bytes: the move was a database update and nothing else.
		expect(await storage.file(objectKey(uploaded.id)).text()).toBe(
			uploaded.body,
		);
	});

	it('rejects a rename onto a name already used in that folder', async () => {
		const first = await uploadSingle({ name: 'one.txt', path: 'work' });
		const second = await uploadSingle({ name: 'two.txt', path: 'work' });

		const conflict = await json(`/files/${second.id}`, 'PATCH', {
			name: 'ONE.TXT',
			path: 'work',
			isPublic: false,
		});

		expect(first.completed.status).toBe(201);
		expect(conflict.status).toBe(409);
	});

	it('deletes the object as well as the row, idempotently', async () => {
		const uploaded = await uploadSingle({ name: 'gone.txt', path: 'work' });

		const first = await request(`/files/${uploaded.id}`, { method: 'DELETE' });
		const second = await request(`/files/${uploaded.id}`, { method: 'DELETE' });

		expect(first.status).toBe(204);
		expect(second.status).toBe(204);
		expect((await request(`/files/${uploaded.id}`)).status).toBe(404);
		expect(await storage.exists(objectKey(uploaded.id))).toBe(false);
	});

	it.each([
		['a size of zero', { size: 0 }],
		['a size beyond what storage accepts', { size: 6 * 1024 ** 4 }],
		['a name holding a path separator', { name: 'a/b.txt' }],
		['a path escaping upwards', { path: '../secrets' }],
		['a path with a leading slash', { path: '/work' }],
	])('rejects %s', async (_case, entry) => {
		const { response } = await reserve([entry]);

		expect(response.status).toBe(422);
	});

	/**
	 * The name can be taken between reserving it and confirming the upload, and
	 * an object with no row is garbage nothing in the app can ever find again.
	 */
	it('removes the uploaded object when its row cannot be written', async () => {
		const decoy = await uploadSingle({ name: 'decoy.txt', path: 'elsewhere' });
		const { results } = await reserve([
			{ name: 'contested.txt', path: 'work' },
		]);
		const [reservation] = results.results;
		if (!reservation?.url) throw new Error('Expected a presigned upload URL');
		await put(reservation.url, 'contested body', 'application/pdf');

		// The decoy slides into the name after it was reserved but before it was used.
		await json(`/files/${decoy.id}`, 'PATCH', {
			name: 'contested.txt',
			path: 'work',
			isPublic: false,
		});
		const completed = await json(
			`/files/${reservation.id}/complete`,
			'POST',
			{},
		);

		expect(completed.status).toBe(409);
		expect(await db.$count(file, inArray(file.id, [reservation.id]))).toBe(0);
		expect(await storage.exists(objectKey(reservation.id))).toBe(false);
	});

	/**
	 * Two completes can race past the same reservation, or a retry can land after
	 * a response was lost. Losing the INSERT on the id means the row already
	 * exists — success, not garbage: deleting the object here would leave the
	 * winner's row pointing at nothing.
	 */
	it('answers a complete that lost the insert race with the stored row, keeping the object', async () => {
		const { results } = await reserve([
			{ name: 'raced.txt', path: 'work', contentType: 'text/plain', size: 5 },
		]);
		const [reservation] = results.results;
		if (!reservation?.url) throw new Error('Expected a presigned upload URL');
		await put(reservation.url, 'hello', 'text/plain');

		const first = await json(`/files/${reservation.id}/complete`, 'POST', {});
		expect(first.status).toBe(201);

		// The competing complete still holds the reservation the winner released:
		await cache.set(
			uploadKey(reservation.id),
			{
				id: reservation.id,
				name: 'raced.txt',
				path: 'work',
				contentType: 'text/plain',
				size: 5,
				uploadedFromNotes: false,
				partSize: 5,
				partCount: 1,
			},
			{ ex: 60 },
		);

		const second = await json(`/files/${reservation.id}/complete`, 'POST', {});

		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({
			id: reservation.id,
			name: 'raced.txt',
		});
		expect(await storage.exists(objectKey(reservation.id))).toBe(true);
		expect(await db.$count(file, inArray(file.id, [reservation.id]))).toBe(1);
		// The loser also lets go of its reservation.
		expect(await cache.get(uploadKey(reservation.id))).toBeNull();
	});

	it('rejects a batch larger than one request is meant to carry', async () => {
		const files = Array.from({ length: 101 }, (_, index) => ({
			id: randomUUIDv7(),
			name: `bulk-${index}.txt`,
			path: 'bulk',
			contentType: 'text/plain',
			size: 4,
		}));

		const response = await json('/files/uploads', 'POST', { files });

		expect(response.status).toBe(422);
	});
});

describe('Files uploaded from Notes', () => {
	it('records where an upload came from, defaulting to the explorer', async () => {
		const manual = await uploadSingle({ name: 'by-hand.txt', path: 'work' });
		const fromNotes = await uploadSingle({
			name: 'attached.txt',
			path: 'Notes',
			uploadedFromNotes: true,
		});

		expect(await manual.completed.json()).toMatchObject({
			uploadedFromNotes: false,
		});
		expect(await fromNotes.completed.json()).toMatchObject({
			uploadedFromNotes: true,
		});
	});

	/**
	 * The point of the endpoint: a file that Notes uploaded and no note mentions
	 * anymore is almost certainly rubbish, and nothing else can tell you that.
	 */
	it('reports a Notes upload no note references', async () => {
		const orphan = await uploadSingle({
			name: 'orphan.txt',
			path: 'Notes',
			uploadedFromNotes: true,
		});

		const response = await request('/files/unreferenced');
		const listed = (await response.json()) as Array<{ id: string }>;

		expect(response.status).toBe(200);
		expect(listed.map((entry) => entry.id)).toContain(orphan.id);
	});

	it('leaves out a file a note still references', async () => {
		const attached = await uploadSingle({
			name: 'in-use.txt',
			path: 'Notes',
			uploadedFromNotes: true,
		});
		await saveNoteReferencing([attached.id]);

		const listed = (await (
			await request('/files/unreferenced')
		).json()) as Array<{ id: string }>;

		expect(listed.map((entry) => entry.id)).not.toContain(attached.id);
	});

	/**
	 * A file uploaded by hand and used nowhere is not an orphan, it is a file.
	 * Only Notes uploads carry the expectation of belonging to something.
	 */
	it('never reports a file that was uploaded by hand', async () => {
		const manual = await uploadSingle({ name: 'standalone.txt', path: 'work' });

		const listed = (await (
			await request('/files/unreferenced')
		).json()) as Array<{ id: string }>;

		expect(listed.map((entry) => entry.id)).not.toContain(manual.id);
	});

	it('reports a file again once the note that held it lets it go', async () => {
		const attached = await uploadSingle({
			name: 'released.txt',
			path: 'Notes',
			uploadedFromNotes: true,
		});
		const noteId = await saveNoteReferencing([attached.id]);
		const whileReferenced = (await (
			await request('/files/unreferenced')
		).json()) as Array<{ id: string }>;

		// The block is removed from the note; the file is deliberately left alone.
		await json(`/notes/${noteId}/mutations`, 'POST', {
			title: 'Emptied',
			path: null,
			createdAt: Date.now() + 1,
			content: [
				{
					id: randomUUIDv7(),
					type: 'paragraph',
					props: {},
					content: [],
					children: [],
				},
			],
		});
		const afterRemoval = (await (
			await request('/files/unreferenced')
		).json()) as Array<{ id: string }>;

		expect(whileReferenced.map((entry) => entry.id)).not.toContain(attached.id);
		expect(afterRemoval.map((entry) => entry.id)).toContain(attached.id);
	});
});

describe('Bulk files', () => {
	it('moves several files in one atomic metadata update', async () => {
		const first = await uploadSingle({ name: 'first.txt', path: 'one' });
		const second = await uploadSingle({ name: 'second.txt', path: 'two' });

		const response = await json('/files/bulk/move', 'PATCH', {
			ids: [first.id, second.id],
			path: 'archive/2026',
		});
		const moved = (await response.json()) as Array<{
			id: string;
			path: string;
		}>;

		expect(response.status).toBe(200);
		expect(moved.map((entry) => [entry.id, entry.path])).toEqual([
			[first.id, 'archive/2026'],
			[second.id, 'archive/2026'],
		]);
		expect(await storage.file(objectKey(first.id)).text()).toBe(first.body);
		expect(await storage.file(objectKey(second.id)).text()).toBe(second.body);
	});

	it('rolls back every move when a destination name conflicts', async () => {
		const existing = await uploadSingle({ name: 'same.txt', path: 'target' });
		const moving = await uploadSingle({ name: 'same.txt', path: 'source' });

		const response = await json('/files/bulk/move', 'PATCH', {
			ids: [moving.id],
			path: 'TARGET',
		});

		expect(existing.completed.status).toBe(201);
		expect(response.status).toBe(409);
		expect(await (await request(`/files/${moving.id}`)).json()).toMatchObject({
			path: 'source',
		});
	});

	it('moves nothing when one requested id is missing', async () => {
		const moving = await uploadSingle({ name: 'kept.txt', path: 'source' });

		const response = await json('/files/bulk/move', 'PATCH', {
			ids: [moving.id, randomUUIDv7()],
			path: 'target',
		});

		expect(response.status).toBe(404);
		expect(await (await request(`/files/${moving.id}`)).json()).toMatchObject({
			path: 'source',
		});
	});

	it('returns signed links for every requested file in request order', async () => {
		const first = await uploadSingle({
			name: 'first.txt',
			path: 'one',
			body: 'first',
		});
		const second = await uploadSingle({
			name: 'second.txt',
			path: 'two',
			body: 'second',
		});

		const response = await json('/files/bulk/links', 'POST', {
			ids: [second.id, first.id],
		});
		const manifest = (await response.json()) as Array<{
			id: string;
			name: string;
			path: string | null;
			url: string;
			expiresAt: number;
		}>;

		expect(response.status).toBe(200);
		expect(manifest.map((entry) => entry.id)).toEqual([second.id, first.id]);
		expect(manifest[0]).toMatchObject({ name: 'second.txt', path: 'two' });
		expect(await (await fetch(manifest[0]?.url ?? '')).text()).toBe('second');
		expect((manifest[0]?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(
			25 * 60 * 1000,
		);
	});

	it('does not issue a partial manifest when one id is missing', async () => {
		const uploaded = await uploadSingle({ name: 'present.txt' });

		const response = await json('/files/bulk/links', 'POST', {
			ids: [uploaded.id, randomUUIDv7()],
		});

		expect(response.status).toBe(404);
	});

	it('deletes several files and treats missing ids idempotently', async () => {
		const first = await uploadSingle({
			name: 'first-delete.txt',
			path: 'bulk',
		});
		const second = await uploadSingle({
			name: 'second-delete.txt',
			path: 'bulk',
		});
		const missing = randomUUIDv7();

		const response = await json('/files/bulk/delete', 'POST', {
			ids: [first.id, missing, second.id],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			deleted: [first.id, missing, second.id],
			failed: [],
		});
		expect(await storage.exists(objectKey(first.id))).toBe(false);
		expect(await storage.exists(objectKey(second.id))).toBe(false);
		expect(await db.$count(file, inArray(file.id, [first.id, second.id]))).toBe(
			0,
		);
	});

	it.each([
		[
			'duplicate ids',
			[randomUUIDv7(), randomUUIDv7()].flatMap((id) => [id, id]),
		],
		['more than 500 ids', Array.from({ length: 501 }, () => randomUUIDv7())],
	])('rejects %s in bulk requests', async (_case, ids) => {
		const response = await json('/files/bulk/delete', 'POST', { ids });
		expect(response.status).toBe(422);
	});
});

type FileSummary = {
	id: string;
	name: string;
	path: string | null;
};

/**
 * The index answers a matching `If-None-Match` from a tag remembered in Redis,
 * so every path that writes the `file` table — completes, metadata, deletes,
 * bulk operations, folder operations and reconcile — must drop that tag
 * before responding.
 */
describe('files index cache', () => {
	async function indexTag() {
		const response = await request('/files');
		expect(response.status).toBe(200);
		return response.headers.get('etag') ?? '';
	}

	const uniqueName = () => `${randomUUIDv7()}.txt`;

	const writes: Array<{
		name: string;
		write: (seeded: {
			id: string;
			path: string;
		}) => Promise<(index: FileSummary[]) => boolean>;
	}> = [
		{
			name: 'completing an upload',
			write: async () => {
				const uploaded = await uploadSingle({ name: uniqueName() });
				return (index) => index.some((row) => row.id === uploaded.id);
			},
		},
		{
			name: 'updating file metadata',
			write: async (seeded) => {
				await json(`/files/${seeded.id}`, 'PATCH', {
					name: 'renamed-after-the-tag.txt',
					path: seeded.path,
					isPublic: false,
				});
				return (index) =>
					index.some(
						(row) =>
							row.id === seeded.id && row.name === 'renamed-after-the-tag.txt',
					);
			},
		},
		{
			name: 'deleting a file',
			write: async (seeded) => {
				await request(`/files/${seeded.id}`, { method: 'DELETE' });
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
		{
			name: 'moving files in bulk',
			write: async (seeded) => {
				const to = `moved-${randomUUIDv7()}`;
				await json('/files/bulk/move', 'PATCH', { ids: [seeded.id], path: to });
				return (index) =>
					index.some((row) => row.id === seeded.id && row.path === to);
			},
		},
		{
			name: 'deleting files in bulk',
			write: async (seeded) => {
				await json('/files/bulk/delete', 'POST', { ids: [seeded.id] });
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
		{
			name: 'renaming a folder',
			write: async (seeded) => {
				const to = `renamed-${randomUUIDv7()}`;
				await json('/files/folders', 'PATCH', { from: seeded.path, to });
				return (index) =>
					index.some((row) => row.id === seeded.id && row.path === to);
			},
		},
		{
			name: 'deleting a folder',
			write: async (seeded) => {
				await request('/files/folders', {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: seeded.path }),
				});
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
		{
			name: 'reconciling a row whose object is gone',
			write: async (seeded) => {
				// Simulates the object being deleted outside the app.
				await storage.delete(objectKey(seeded.id));
				await json('/files/reconcile', 'POST', {});
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
	];

	for (const entry of writes)
		it(`serves a fresh index after ${entry.name}`, async () => {
			const path = `cache-${randomUUIDv7()}`;
			const seeded = await uploadSingle({ name: uniqueName(), path });
			const tag = await indexTag();
			const unchanged = await request('/files', {
				headers: { 'if-none-match': tag },
			});
			expect(unchanged.status).toBe(304);

			const reflected = await entry.write({ id: seeded.id, path });

			const after = await request('/files', {
				headers: { 'if-none-match': tag },
			});
			expect(after.status).toBe(200);
			expect(reflected((await after.json()) as FileSummary[])).toBe(true);
		});
});
