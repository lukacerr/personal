import { afterEach, describe, expect, it } from 'bun:test';
import { cache, db, storage } from '@api/env';
import { objectKey, uploadKey } from '@api/files-storage';
import { file } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';
import { json, request } from './helpers';

const createdIds = new Set<string>();

async function storeFile({
	name = 'shared.txt',
	path = 'work' as string | null,
	contentType = 'text/plain',
	body = 'public body',
	isPublic = false,
} = {}) {
	const id = randomUUIDv7();
	createdIds.add(id);
	const reserved = await json('/files/uploads', 'POST', {
		files: [{ id, name, path, contentType, size: body.length }],
	});
	const { results } = (await reserved.json()) as {
		results: Array<{ url?: string }>;
	};
	const url = results[0]?.url;
	if (!url) throw new Error('Expected a presigned upload URL');

	await fetch(url, {
		method: 'PUT',
		headers: { 'content-type': contentType },
		body,
	});
	await json(`/files/${id}/complete`, 'POST', {});
	if (isPublic)
		await json(`/files/${id}`, 'PATCH', { name, path, isPublic: true });

	return { id, name, path, contentType, body };
}

/** Reads the counter the way the app does: from the private index. */
async function indexRow(id: string) {
	const response = await request('/files');
	const index = (await response.json()) as Array<{
		id: string;
		viewCount: number;
		updatedAt: number;
	}>;
	return index.find((row) => row.id === id);
}

afterEach(async () => {
	const ids = [...createdIds];
	createdIds.clear();
	if (ids.length === 0) return;

	await db.delete(file).where(inArray(file.id, ids));
	await Promise.all(
		ids.flatMap((id) => [
			storage.delete(objectKey(id)).catch(() => undefined),
			cache.del(uploadKey(id)),
		]),
	);
	const keys = await cache.keys('storage:name:*');
	if (keys.length > 0) await cache.del(...keys);
});

describe('Public files', () => {
	it('serves a published file without any credentials', async () => {
		const stored = await storeFile({ isPublic: true });

		const response = await request(`/public/files/${stored.id}`, {
			redirect: 'manual',
		});
		const location = response.headers.get('location');

		expect(response.status).toBe(302);
		if (!location) throw new Error('Expected a redirect to storage');
		expect(await (await fetch(location)).text()).toBe(stored.body);
	});

	it('counts every public read without touching the edit clock', async () => {
		const stored = await storeFile({ isPublic: true });
		const before = await indexRow(stored.id);

		await request(`/public/files/${stored.id}`, { redirect: 'manual' });
		await request(`/public/files/${stored.id}`, { redirect: 'manual' });

		const after = await indexRow(stored.id);
		expect(after?.viewCount).toBe(2);
		// A view is not an edit: the row's own clock must not move.
		expect(after?.updatedAt).toBe(before?.updatedAt ?? Number.NaN);
	});

	it('does not count a read it refused', async () => {
		const stored = await storeFile({ isPublic: false });

		await request(`/public/files/${stored.id}`);

		expect((await indexRow(stored.id))?.viewCount).toBe(0);
	});

	it('serves a fresh index after a public read', async () => {
		const stored = await storeFile({ isPublic: true });
		const first = await request('/files');
		const tag = first.headers.get('etag') ?? '';
		const unchanged = await request('/files', {
			headers: { 'if-none-match': tag },
		});
		expect(unchanged.status).toBe(304);

		await request(`/public/files/${stored.id}`, { redirect: 'manual' });

		const after = await request('/files', {
			headers: { 'if-none-match': tag },
		});
		expect(after.status).toBe(200);
	});

	/**
	 * Answering differently would turn this endpoint into an oracle for which
	 * ids exist, which is the one thing an unauthenticated route must not be.
	 */
	it('answers identically for a private file and one that never existed', async () => {
		const stored = await storeFile({ isPublic: false });

		const privateFile = await request(`/public/files/${stored.id}`);
		const missing = await request(`/public/files/${randomUUIDv7()}`);

		expect(privateFile.status).toBe(404);
		expect(await privateFile.json()).toEqual(await missing.json());
	});

	it('stops serving a file the moment it is unpublished', async () => {
		const stored = await storeFile({ isPublic: true });

		const published = await request(`/public/files/${stored.id}`, {
			redirect: 'manual',
		});
		await json(`/files/${stored.id}`, 'PATCH', {
			name: stored.name,
			path: stored.path,
			isPublic: false,
		});
		const revoked = await request(`/public/files/${stored.id}`);

		expect(published.status).toBe(302);
		expect(revoked.status).toBe(404);
	});

	it('never discloses which folder holds a shared file', async () => {
		const stored = await storeFile({ isPublic: true, path: 'private/plans' });

		const response = await request(`/public/files/${stored.id}`, {
			redirect: 'manual',
		});

		expect(JSON.stringify([...response.headers])).not.toContain(
			'private/plans',
		);
	});

	/**
	 * A public SVG or HTML file rendered inline executes its own script. The
	 * bytes live on the storage domain rather than ours, so the blast radius is
	 * already limited, but it is not a capability worth handing out.
	 */
	it.each([
		['an svg', 'image/svg+xml', 'attachment'],
		['a web page', 'text/html', 'attachment'],
		['an image', 'image/png', 'inline'],
		['a pdf', 'application/pdf', 'inline'],
	])('serves %s as %s', async (_case, contentType, expected) => {
		const stored = await storeFile({
			name: `sample.${contentType.split('/')[1]}`,
			contentType,
			isPublic: true,
		});

		const response = await request(`/public/files/${stored.id}`, {
			redirect: 'manual',
		});
		const location = response.headers.get('location');
		if (!location) throw new Error('Expected a redirect to storage');
		const served = await fetch(location);

		expect(served.headers.get('content-disposition')).toContain(expected);
	});
});
