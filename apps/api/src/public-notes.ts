import { db } from '@api/env';
import { note } from '@api/schema';
import { and, eq } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

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
		// has no reason to travel with a shared note.
		const [result] = await db
			.select({ id: note.id, title: note.title, content: note.content })
			.from(note)
			.where(and(eq(note.id, params.id), eq(note.isPublic, true)))
			.limit(1);

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
