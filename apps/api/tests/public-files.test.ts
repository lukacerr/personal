import { afterEach, describe, expect, it } from 'bun:test';
import { cache, db, storage } from '@api/env';
import { objectKey, uploadKey } from '@api/files-storage';
import { app } from '@api/index';
import { file } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';

const createdIds = new Set<string>();

async function request(path: string, init?: RequestInit) {
	return app.handle(new Request(`http://localhost${path}`, init));
}

async function json(path: string, method: string, body: unknown) {
	return request(path, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

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
