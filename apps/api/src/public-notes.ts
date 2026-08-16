import { db } from '@api/env';
import { createIndexCache } from '@api/http-cache';
import { note } from '@api/schema';
import { and, eq, sql } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

/** Same key as the private router's instance: a public read is a write too. */
const indexCache = createIndexCache('notes');

/**
 * The only unauthenticated view of a note, kept in its own router so it can
 * never inherit `authPlugin` by sitting next to a private route.
 */
export const publicNotesRouter = new Elysia({
	prefix: '/public/notes',
	tags: ['Public notes'],
}).get(
	'/:id',
	async ({ params }) => {
		// Title and document only: the containing folder is private structure and
		// has no reason to travel with a shared note. Serving and counting are one
		// statement, so a served read is never lost between a select and a write.
		const [result] = await db
			.update(note)
			.set({ viewCount: sql`${note.viewCount} + 1` })
			.where(and(eq(note.id, params.id), eq(note.isPublic, true)))
			.returning({ id: note.id, title: note.title, content: note.content });
		await indexCache.invalidate();

		// A private note and one that never existed answer identically, or this
		// endpoint becomes an oracle for which ids exist.
		if (!result) return status(404, { error: 'NOTE_NOT_FOUND' });

		return result;
	},
	{
		params: z.object({ id: z.uuid() }),
		detail: { summary: 'Read a published note' },
	},
);
