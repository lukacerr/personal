import { db, presigner } from '@api/env';
import { contentDisposition, objectKey } from '@api/files-storage';
import { file } from '@api/schema';
import { and, eq } from 'drizzle-orm';
import Elysia, { redirect, status } from 'elysia';
import { z } from 'zod';

const LINK_TTL_SECONDS = 5 * 60;

/**
 * Types a browser will execute if it renders them inline. The bytes are served
 * from the storage domain rather than ours, so the damage is already contained,
 * but a public SVG that runs script is not a capability worth offering.
 */
const EXECUTABLE_TYPES = new Set([
	'text/html',
	'text/xml',
	'image/svg+xml',
	'application/xhtml+xml',
	'application/xml',
]);

function dispositionFor(contentType: string) {
	const type = contentType.split(';')[0]?.trim().toLocaleLowerCase() ?? '';
	return EXECUTABLE_TYPES.has(type) || type.endsWith('+xml')
		? 'attachment'
		: 'inline';
}

/**
 * The only unauthenticated view of a file, kept in its own router so it can
 * never inherit `authPlugin` by sitting next to a private route.
 *
 * The link is stable, so it can be pasted anywhere, while the signature behind
 * the redirect is short-lived and unpublishing cuts access immediately.
 */
export const publicFilesRouter = new Elysia({
	prefix: '/public/files',
	tags: ['Public files'],
}).get(
	'/:id',
	async ({ params }) => {
		const [result] = await db
			.select({ name: file.name, contentType: file.contentType })
			.from(file)
			.where(and(eq(file.id, params.id), eq(file.isPublic, true)))
			.limit(1)
			.$withCache(false);

		// A private file and one that never existed answer identically, or this
		// endpoint becomes an oracle for which ids exist.
		if (!result) return status(404, { error: 'FILE_NOT_FOUND' });

		return redirect(
			presigner.presign(objectKey(params.id), {
				method: 'GET',
				expiresIn: LINK_TTL_SECONDS,
				type: result.contentType,
				contentDisposition: contentDisposition(
					dispositionFor(result.contentType),
					result.name,
				),
			}),
		);
	},
	{
		params: z.object({ id: z.uuid() }),
		detail: { summary: 'Read a published file' },
	},
);
