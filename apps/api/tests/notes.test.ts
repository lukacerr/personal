import { afterEach, describe, expect, it } from 'bun:test';
import { db } from '@api/env';
import { app } from '@api/index';
import { note, noteMutation } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { eq, inArray, sql } from 'drizzle-orm';

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

async function request(path: string, init?: RequestInit) {
	return app.handle(new Request(`http://localhost${path}`, init));
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

		const renamed = await request(`/notes/${saved.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Renamed', path: 'archive' }),
		});
		const detail = await request(`/notes/${saved.id}`);
		const history = await request(`/notes/${saved.id}/mutations`);
		const conflict = await request(`/notes/${saved.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'existing', path: 'ARCHIVE' }),
		});

		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toEqual({
			id: saved.id,
			title: 'Renamed',
			path: 'archive',
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
