import { afterEach, describe, expect, it } from 'bun:test';
import { db } from '@api/env';
import { KEYFRAME_INTERVAL } from '@api/note-versions';
import { reconstructionWindow } from '@api/notes';
import { note, noteMutation } from '@api/schema';
import { MAX_CLOCK_SKEW_MS } from '@api/validation';
import { randomUUIDv7 } from 'bun';
import { eq, inArray, sql } from 'drizzle-orm';
import { request } from './helpers';

const createdNoteIds = new Set<string>();

function document(text: string) {
	return [
		{
			id: randomUUIDv7(),
			type: 'paragraph',
			props: {
				backgroundColor: 'default',
				textAlignment: 'left',
				textColor: 'default',
			},
			content: [{ type: 'text', text, styles: {} }],
			children: [],
		},
	];
}

async function saveNote({
	id = randomUUIDv7(),
	title = 'Architecture',
	path = 'personal/projects',
	createdAt = Date.now(),
	content = document(title),
}: {
	id?: string;
	title?: string;
	path?: string | null;
	createdAt?: number;
	content?: ReturnType<typeof document>;
} = {}) {
	createdNoteIds.add(id);
	const response = await request(`/notes/${id}/mutations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title, path, createdAt, content }),
	});

	return { response, id, title, path, createdAt, content };
}

async function patchNote(
	id: string,
	metadata: { title: string; path: string | null; isPublic?: boolean },
) {
	return request(`/notes/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ isPublic: false, ...metadata }),
	});
}

afterEach(async () => {
	if (createdNoteIds.size > 0)
		await db.delete(note).where(inArray(note.id, [...createdNoteIds]));
	createdNoteIds.clear();
});

describe('Notes', () => {
	it('creates a note from its first mutation and returns numeric timestamps', async () => {
		const before = Date.now();
		const saved = await saveNote();
		const after = Date.now();

		expect(saved.response.status).toBe(201);
		const result = (await saved.response.json()) as { createdAt: number };
		expect(result).toMatchObject({
			id: saved.id,
			title: saved.title,
			path: saved.path,
			updatedAt: saved.createdAt,
			content: saved.content,
		});
		expect(result.createdAt).toBeGreaterThanOrEqual(before);
		expect(result.createdAt).toBeLessThanOrEqual(after);
	});

	it('lists summaries without transporting document content', async () => {
		const saved = await saveNote({ path: null });

		const response = await request('/notes');

		expect(response.status).toBe(200);
		const result = (await response.json()) as Array<{
			id: string;
			title: string;
			path: string | null;
			createdAt: number;
			updatedAt: number;
		}>;
		const summary = result.find((item: { id: string }) => item.id === saved.id);
		expect(summary).toMatchObject({
			id: saved.id,
			title: saved.title,
			path: null,
			updatedAt: saved.createdAt,
		});
		expect(summary).not.toHaveProperty('content');
	});

	it('returns the latest snapshot and preserves idempotent history', async () => {
		const id = randomUUIDv7();
		const olderAt = Date.now() - 2_000;
		const newerAt = olderAt + 1_000;
		const older = await saveNote({
			id,
			title: 'Old title',
			path: 'old/path',
			createdAt: olderAt,
			content: document('Older'),
		});
		const newer = await saveNote({
			id,
			title: 'New title',
			path: 'new/path',
			createdAt: newerAt,
			content: document('Newer'),
		});
		await saveNote({
			id,
			title: older.title,
			path: older.path,
			createdAt: olderAt,
			content: older.content,
		});

		const detailResponse = await request(`/notes/${id}`);
		const historyResponse = await request(`/notes/${id}/mutations`);

		expect(detailResponse.status).toBe(200);
		expect(await detailResponse.json()).toMatchObject({
			id,
			title: newer.title,
			path: newer.path,
			updatedAt: newerAt,
			content: newer.content,
		});
		expect(historyResponse.status).toBe(200);
		expect(await historyResponse.json()).toEqual({
			versions: [{ createdAt: newerAt }, { createdAt: olderAt }],
			hasMore: false,
		});
	});

	it('returns a historical snapshot without modifying the current note', async () => {
		const id = randomUUIDv7();
		const createdAt = Date.now() - 1_000;
		const historical = document('Historical');
		await saveNote({ id, createdAt, content: historical });
		await saveNote({
			id,
			createdAt: createdAt + 500,
			content: document('Current'),
		});

		const response = await request(`/notes/${id}/mutations/${createdAt}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ createdAt, content: historical });
	});

	it('rejects duplicate names in the same folder ignoring case', async () => {
		await saveNote({ title: 'Ideas', path: 'Work' });
		const duplicate = await saveNote({ title: 'ideas', path: 'work' });

		expect(duplicate.response.status).toBe(409);
	});

	it('updates metadata without creating a content version and rejects conflicts', async () => {
		const saved = await saveNote({ title: 'Draft', path: 'work' });
		await saveNote({ title: 'Existing', path: 'archive' });

		const renamed = await patchNote(saved.id, {
			title: 'Renamed',
			path: 'archive',
		});
		const detail = await request(`/notes/${saved.id}`);
		const history = await request(`/notes/${saved.id}/mutations`);
		const conflict = await patchNote(saved.id, {
			title: 'existing',
			path: 'ARCHIVE',
		});

		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toEqual({
			id: saved.id,
			title: 'Renamed',
			path: 'archive',
			isPublic: false,
		});
		expect(await detail.json()).toMatchObject({
			title: 'Renamed',
			path: 'archive',
			updatedAt: saved.createdAt,
		});
		expect(await history.json()).toEqual({
			versions: [{ createdAt: saved.createdAt }],
			hasMore: false,
		});
		expect(conflict.status).toBe(409);
	});

	it('publishes a note through its metadata and reports it everywhere it is read', async () => {
		const saved = await saveNote({ title: 'Shared', path: 'study' });

		const published = await patchNote(saved.id, {
			title: 'Shared',
			path: 'study',
			isPublic: true,
		});
		const detail = await request(`/notes/${saved.id}`);
		const summaries = await request('/notes');

		expect(published.status).toBe(200);
		expect(await published.json()).toMatchObject({ isPublic: true });
		expect(await detail.json()).toMatchObject({ isPublic: true });
		const summary = (
			(await summaries.json()) as Array<{ id: string; isPublic: boolean }>
		).find((item) => item.id === saved.id);
		expect(summary).toMatchObject({ isPublic: true });
	});

	it('starts a note private and never lets a content save change that', async () => {
		const saved = await saveNote({ title: 'Private', path: 'study' });
		const created = (await saved.response.json()) as { isPublic: boolean };
		await patchNote(saved.id, {
			title: 'Private',
			path: 'study',
			isPublic: true,
		});

		// The save response feeds the local cache, so it has to carry the flag or
		// every save would quietly unpublish the note on the device that wrote it.
		const edited = await saveNote({
			id: saved.id,
			title: 'Private',
			path: 'study',
			createdAt: saved.createdAt + 1_000,
			content: document('Edited after publishing'),
		});
		const detail = await request(`/notes/${saved.id}`);

		expect(created.isPublic).toBe(false);
		expect(await edited.response.json()).toMatchObject({ isPublic: true });
		expect(await detail.json()).toMatchObject({ isPublic: true });
	});

	it('returns 422 for invalid input instead of crashing in the logger', async () => {
		const invalidPath = await saveNote({ path: '/leading/slash' });
		const invalidDocument = await request(
			`/notes/${randomUUIDv7()}/mutations`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Invalid',
					path: null,
					createdAt: Date.now(),
					content: ['not-a-block'],
				}),
			},
		);
		const invalidBlockId = randomUUIDv7();
		createdNoteIds.add(invalidBlockId);
		const invalidBlock = await request(`/notes/${invalidBlockId}/mutations`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Invalid block',
				path: null,
				createdAt: Date.now(),
				content: [{}],
			}),
		});

		expect(invalidPath.response.status).toBe(422);
		expect(invalidDocument.status).toBe(422);
		expect(invalidBlock.status).toBe(422);
	});

	it('renames only the requested folder prefix', async () => {
		const direct = await saveNote({ title: 'Direct', path: 'work' });
		const nested = await saveNote({ title: 'Nested', path: 'work/projects' });
		const neighbor = await saveNote({ title: 'Neighbor', path: 'workbench' });

		const response = await request('/notes/folders', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ from: 'WORK', to: 'archive/work' }),
		});
		const list = (await (await request('/notes')).json()) as Array<{
			id: string;
			path: string | null;
		}>;

		expect(response.status).toBe(200);
		expect(response.json()).resolves.toEqual({ updated: 2 });
		expect(list.find((item) => item.id === direct.id)?.path).toBe(
			'archive/work',
		);
		expect(list.find((item) => item.id === nested.id)?.path).toBe(
			'archive/work/projects',
		);
		expect(list.find((item) => item.id === neighbor.id)?.path).toBe(
			'workbench',
		);
	});

	it('stores older versions as deltas and still serves each one whole', async () => {
		const id = randomUUIDv7();
		const base = Date.now() - 60_000;
		const revisions = Array.from({ length: 6 }, (_, index) => ({
			createdAt: base + index * 1_000,
			content: document(`Revision ${index}`),
		}));
		for (const revision of revisions) await saveNote({ id, ...revision });

		const restored = await Promise.all(
			revisions.map(async (revision) => {
				const response = await request(
					`/notes/${id}/mutations/${revision.createdAt}`,
				);
				return { status: response.status, body: await response.json() };
			}),
		);
		const [stored] = await db
			.select({
				snapshots: sql<number>`count(*) filter (where ${noteMutation.content} is not null)::int`,
				deltas: sql<number>`count(*) filter (where ${noteMutation.delta} is not null)::int`,
			})
			.from(noteMutation)
			.where(eq(noteMutation.noteId, id));

		for (const [index, result] of restored.entries()) {
			expect(result.status).toBe(200);
			expect(result.body).toEqual({
				createdAt: revisions[index]?.createdAt,
				content: revisions[index]?.content,
			});
		}
		// The current document lives on the note, so history holds only deltas.
		expect(stored).toEqual({ snapshots: 0, deltas: revisions.length - 1 });
	});

	it('pages history newest first and reports whether older versions remain', async () => {
		const id = randomUUIDv7();
		const base = Date.now() - 60_000;
		const stamps = Array.from(
			{ length: 5 },
			(_, index) => base + index * 1_000,
		);
		for (const createdAt of stamps)
			await saveNote({ id, createdAt, content: document(`R${createdAt}`) });

		const firstPage = await request(`/notes/${id}/mutations?limit=2`);
		const first = (await firstPage.json()) as {
			versions: { createdAt: number }[];
			hasMore: boolean;
		};
		const nextPage = await request(
			`/notes/${id}/mutations?limit=2&before=${first.versions.at(-1)?.createdAt}`,
		);
		const next = (await nextPage.json()) as {
			versions: { createdAt: number }[];
			hasMore: boolean;
		};

		const newest = [...stamps].reverse();
		expect(first.versions.map((item) => item.createdAt)).toEqual(
			newest.slice(0, 2),
		);
		expect(first.hasMore).toBe(true);
		expect(next.versions.map((item) => item.createdAt)).toEqual(
			newest.slice(2, 4),
		);
		expect(next.hasMore).toBe(true);
	});

	it('leaves an out-of-order save as its own snapshot', async () => {
		const id = randomUUIDv7();
		const newerAt = Date.now();
		const olderAt = newerAt - 5_000;
		const newer = document('Newer');
		const older = document('Older');
		await saveNote({ id, createdAt: newerAt, content: newer });
		await saveNote({ id, createdAt: olderAt, content: older });

		const olderResponse = await request(`/notes/${id}/mutations/${olderAt}`);
		const current = await request(`/notes/${id}`);

		expect(await olderResponse.json()).toEqual({
			createdAt: olderAt,
			content: older,
		});
		expect(await current.json()).toMatchObject({
			updatedAt: newerAt,
			content: newer,
		});
	});

	it('treats folder wildcards as literal characters when renaming', async () => {
		const target = await saveNote({ title: 'Target', path: 'plan_a/notes' });
		const neighbor = await saveNote({
			title: 'Neighbor',
			path: 'planXa/notes',
		});
		const percent = await saveNote({ title: 'Percent', path: 'other/deep' });

		const response = await request('/notes/folders', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ from: 'plan_a', to: 'archive' }),
		});
		const list = (await (await request('/notes')).json()) as Array<{
			id: string;
			path: string | null;
		}>;

		expect(await response.json()).toEqual({ updated: 1 });
		expect(list.find((item) => item.id === target.id)?.path).toBe(
			'archive/notes',
		);
		expect(list.find((item) => item.id === neighbor.id)?.path).toBe(
			'planXa/notes',
		);
		expect(list.find((item) => item.id === percent.id)?.path).toBe(
			'other/deep',
		);
	});

	it('treats folder wildcards as literal characters when deleting', async () => {
		const target = await saveNote({ title: 'Target', path: 'plan_a/notes' });
		const neighbor = await saveNote({
			title: 'Neighbor',
			path: 'planXa/notes',
		});
		const everything = await saveNote({
			title: 'Everything',
			path: 'any/where',
		});

		const underscore = await request('/notes/folders', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'plan_a' }),
		});
		const wildcard = await request('/notes/folders', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: '%' }),
		});

		expect(await underscore.json()).toEqual({ deleted: 1 });
		expect(await wildcard.json()).toEqual({ deleted: 0 });
		expect((await request(`/notes/${target.id}`)).status).toBe(404);
		expect((await request(`/notes/${neighbor.id}`)).status).toBe(200);
		expect((await request(`/notes/${everything.id}`)).status).toBe(200);
	});

	it('rejects content timestamps beyond the supported date range', async () => {
		const unsupported = await saveNote({ createdAt: 9_000_000_000_000_000 });

		expect(unsupported.response.status).toBe(422);
	});

	/**
	 * A save clock from the far future would out-rank every later edit for good:
	 * the note becomes uneditable because no honest clock can ever beat it.
	 */
	it('rejects a save clocked further ahead than clock skew can explain', async () => {
		const tooFar = await saveNote({
			createdAt: Date.now() + MAX_CLOCK_SKEW_MS + 60_000,
		});

		expect(tooFar.response.status).toBe(422);
	});

	/**
	 * The folder endpoints take the same kind of path a note does and must reject
	 * the same things. Deriving the non-null schema by unwrapping a nullable one
	 * quietly drops the refinements added after `.nullable()`, leaving nothing
	 * validated but the length.
	 */
	it.each([
		['a trailing slash', 'a/'],
		['nothing at all', ''],
		['a parent reference', '..'],
		['a leading slash', '/a'],
		['an empty segment', 'a//b'],
	])('refuses a folder path with %s', async (_case, path) => {
		const renamed = await request('/notes/folders', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ from: path, to: 'archive' }),
		});
		const renamedTo = await request('/notes/folders', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ from: 'work', to: path }),
		});
		const deleted = await request('/notes/folders', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path }),
		});

		expect(renamed.status).toBe(422);
		expect(renamedTo.status).toBe(422);
		expect(deleted.status).toBe(422);
	});

	// Crossing a keyframe takes KEYFRAME_INTERVAL+ sequential saves, so this
	// test cannot fit the default 5 s timeout.
	it('rebuilds an old version reading only up to the nearest keyframe', async () => {
		const id = randomUUIDv7();
		const base = Date.now() - 600_000;
		const revisions = Array.from(
			{ length: KEYFRAME_INTERVAL + 3 },
			(_, index) => ({
				createdAt: base + index * 1_000,
				content: document(`Revision ${index}`),
			}),
		);
		for (const revision of revisions) await saveNote({ id, ...revision });

		const oldest = await request(
			`/notes/${id}/mutations/${revisions[0]?.createdAt}`,
		);
		expect(oldest.status).toBe(200);
		expect(await oldest.json()).toEqual({
			createdAt: revisions[0]?.createdAt,
			content: revisions[0]?.content,
		});

		// The route reads only up to the anchor. Asserted on the exported query
		// because HTTP cannot observe how many rows were fetched.
		const rows = await reconstructionWindow(
			id,
			new Date(revisions[0]?.createdAt ?? 0),
		);
		expect(rows.length).toBe(KEYFRAME_INTERVAL);
		expect(rows.length).toBeLessThan(revisions.length - 1);
		// Newest first, so the anchor keyframe heads the window.
		expect(rows[0]?.content).not.toBeNull();
	}, 30_000);

	/**
	 * An out-of-order save is a standalone snapshot the surrounding chain skips
	 * right over. The bounded window stops at the first snapshot by time, which
	 * cuts this chain short — the route must still rebuild the version instead of
	 * reporting it unrecoverable.
	 */
	it('rebuilds a version whose chain hops over an out-of-order snapshot', async () => {
		const id = randomUUIDv7();
		const base = Date.now() - 60_000;
		const first = document('First');
		await saveNote({ id, createdAt: base, content: first });
		await saveNote({
			id,
			createdAt: base + 10_000,
			content: document('Second'),
		});
		await saveNote({
			id,
			createdAt: base + 20_000,
			content: document('Third'),
		});
		// Synced late: lands between the first two as its own snapshot.
		await saveNote({ id, createdAt: base + 5_000, content: document('Late') });

		const response = await request(`/notes/${id}/mutations/${base}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ createdAt: base, content: first });
	});

	it('dates a note from its first mutation instead of its sync time', async () => {
		const createdAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const saved = await saveNote({ createdAt });
		await saveNote({ id: saved.id, createdAt: createdAt + 1_000 });

		const detail = await request(`/notes/${saved.id}`);

		expect(await detail.json()).toMatchObject({ createdAt });
	});

	it('deletes folders recursively and notes idempotently', async () => {
		const deleted = await saveNote({ path: 'discard/nested' });
		const retained = await saveNote({ path: 'discarded' });

		const folderResponse = await request('/notes/folders', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'discard' }),
		});
		const firstDelete = await request(`/notes/${retained.id}`, {
			method: 'DELETE',
		});
		const secondDelete = await request(`/notes/${retained.id}`, {
			method: 'DELETE',
		});

		expect(folderResponse.status).toBe(200);
		expect(await folderResponse.json()).toEqual({ deleted: 1 });
		expect((await request(`/notes/${deleted.id}`)).status).toBe(404);
		expect(firstDelete.status).toBe(204);
		expect(secondDelete.status).toBe(204);
	});
});

type NoteSummary = {
	id: string;
	title: string;
	path: string | null;
	isPublic: boolean;
	createdAt: number;
	updatedAt: number;
};

/**
 * The index answers a matching `If-None-Match` from a tag remembered in Redis,
 * so every write path — saves, metadata, deletes and both folder operations —
 * must drop that tag before responding.
 */
describe('notes index cache', () => {
	async function indexTag() {
		const response = await request('/notes');
		expect(response.status).toBe(200);
		return response.headers.get('etag') ?? '';
	}

	function uniqueFolder() {
		return `cache-${randomUUIDv7()}`;
	}

	const writes: Array<{
		name: string;
		write: (seeded: {
			id: string;
			path: string;
			createdAt: number;
		}) => Promise<(index: NoteSummary[]) => boolean>;
	}> = [
		{
			name: 'saving a new note',
			write: async () => {
				const { id } = await saveNote();
				return (index) => index.some((row) => row.id === id);
			},
		},
		{
			name: 'saving an existing note',
			write: async (seeded) => {
				await saveNote({
					id: seeded.id,
					title: 'Renamed by a save',
					createdAt: seeded.createdAt + 1,
				});
				return (index) =>
					index.some(
						(row) => row.id === seeded.id && row.title === 'Renamed by a save',
					);
			},
		},
		{
			name: 'updating note metadata',
			write: async (seeded) => {
				await patchNote(seeded.id, { title: 'Renamed metadata', path: null });
				return (index) =>
					index.some(
						(row) => row.id === seeded.id && row.title === 'Renamed metadata',
					);
			},
		},
		{
			name: 'deleting a note',
			write: async (seeded) => {
				await request(`/notes/${seeded.id}`, { method: 'DELETE' });
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
		{
			name: 'renaming a folder',
			write: async (seeded) => {
				const to = uniqueFolder();
				await request('/notes/folders', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ from: seeded.path, to }),
				});
				return (index) =>
					index.some((row) => row.id === seeded.id && row.path === to);
			},
		},
		{
			name: 'deleting a folder',
			write: async (seeded) => {
				await request('/notes/folders', {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: seeded.path }),
				});
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
	];

	for (const entry of writes)
		it(`serves a fresh index after ${entry.name}`, async () => {
			const path = uniqueFolder();
			const seeded = await saveNote({ path });
			const tag = await indexTag();
			const unchanged = await request('/notes', {
				headers: { 'if-none-match': tag },
			});
			expect(unchanged.status).toBe(304);

			const reflected = await entry.write({
				id: seeded.id,
				path,
				createdAt: seeded.createdAt,
			});

			const after = await request('/notes', {
				headers: { 'if-none-match': tag },
			});
			expect(after.status).toBe(200);
			expect(reflected((await after.json()) as NoteSummary[])).toBe(true);
		});
});
