import { afterEach, describe, expect, it } from 'bun:test';
import { db } from '@api/env';
import { app } from '@api/index';
import { note } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';

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

async function createNote({
	title = 'Shared study notes',
	path = 'study/algebra',
	isPublic = false,
	content = document('Shared body'),
} = {}) {
	const id = randomUUIDv7();
	createdNoteIds.add(id);
	await request(`/notes/${id}/mutations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title, path, createdAt: Date.now(), content }),
	});
	if (isPublic) await publish(id, { title, path, isPublic: true });
	return { id, title, path, content };
}

async function publish(
	id: string,
	body: { title: string; path: string | null; isPublic: boolean },
) {
	return request(`/notes/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

afterEach(async () => {
	if (createdNoteIds.size > 0)
		await db.delete(note).where(inArray(note.id, [...createdNoteIds]));
	createdNoteIds.clear();
});

describe('Public notes', () => {
	it('serves a published note without any credentials', async () => {
		const published = await createNote({ isPublic: true });

		const response = await request(`/public/notes/${published.id}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: published.id,
			title: published.title,
			content: published.content,
		});
	});

	it('never discloses which folder holds a shared note', async () => {
		const published = await createNote({
			isPublic: true,
			path: 'study/private-client-name',
		});

		const response = await request(`/public/notes/${published.id}`);

		expect(await response.json()).not.toHaveProperty('path');
	});

	it('answers identically for a private note and one that never existed', async () => {
		const privateNote = await createNote({ isPublic: false });

		const denied = await request(`/public/notes/${privateNote.id}`);
		const absent = await request(`/public/notes/${randomUUIDv7()}`);

		expect(denied.status).toBe(404);
		expect(absent.status).toBe(404);
		expect(await denied.json()).toEqual(await absent.json());
	});

	it('stops serving a note as soon as it is unpublished', async () => {
		const published = await createNote({ isPublic: true });

		await publish(published.id, {
			title: published.title,
			path: published.path,
			isPublic: false,
		});
		const response = await request(`/public/notes/${published.id}`);

		expect(response.status).toBe(404);
	});
});
