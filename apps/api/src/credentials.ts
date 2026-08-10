import { authPlugin } from '@api/auth';
import { decryptCredentialValue } from '@api/credentials-crypto';
import { db, env } from '@api/env';
import { entityTag, isUnchanged } from '@api/http-cache';
import { credential } from '@api/schema';
import { eq } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const credentialId = z.uuid();
const credentialTitle = z.string().trim().min(1).max(255);
/**
 * The envelope, bounded at the HTTP edge by roughly what the largest allowed
 * plaintext can grow into: base64 costs a third on top of the salt, iv and tag.
 * It is a ceiling on the request, not the product rule — the limit that matters
 * is on the plaintext, and only decrypting can tell us that one.
 */
const credentialEnvelope = z.string().min(1).max(8192);
const MAX_PLAINTEXT_LENGTH = 4096;

const credentialColumns = {
	id: credential.id,
	title: credential.title,
	value: credential.value,
	createdAt: credential.createdAt,
	updatedAt: credential.updatedAt,
};

type CredentialRow = {
	id: string;
	title: string;
	value: string;
	createdAt: Date;
	updatedAt: Date;
};

/**
 * Timestamps travel as epoch milliseconds, like every other system here, and
 * `value` travels as the envelope it is stored as. There is no shape of this
 * response that carries a plaintext.
 */
function serialize(row: CredentialRow) {
	return {
		...row,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * Whether an envelope is worth storing.
 *
 * The client encrypts, so this is the only moment the server can tell a real
 * envelope from a client bug or a stale secret. Rejecting here is what makes an
 * unreadable row impossible: otherwise the write succeeds, the value is lost for
 * good, and nobody finds out until the day they need it. The plaintext exists
 * only inside this function and is never returned, logged or stored.
 */
async function inspectEnvelope(envelope: string) {
	const decrypted = await decryptCredentialValue(envelope, env.LUKA_SECRET);
	if (!decrypted.ok) return 'not-decryptable' as const;
	return decrypted.value.length > MAX_PLAINTEXT_LENGTH
		? ('too-large' as const)
		: ('ok' as const);
}

export const credentialsRouter = new Elysia({
	prefix: '/credentials',
	tags: ['Credentials'],
})
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) => {
			const credentials = await db
				.select(credentialColumns)
				.from(credential)
				.orderBy(credential.title)
				.$withCache(false);

			const payload = credentials.map(serialize);
			const tag = entityTag(payload);
			set.headers.etag = tag;
			return isUnchanged(request, tag) ? status(304) : payload;
		},
		{ detail: { summary: 'List credentials' } },
	)
	.post(
		'/',
		async ({ body }) => {
			const inspection = await inspectEnvelope(body.value);
			if (inspection === 'not-decryptable')
				return status(422, { error: 'CREDENTIAL_NOT_DECRYPTABLE' });
			if (inspection === 'too-large')
				return status(422, { error: 'CREDENTIAL_VALUE_TOO_LARGE' });

			const [created] = await db
				.insert(credential)
				.values({ title: body.title, value: body.value })
				.returning(credentialColumns);

			if (!created) throw new Error('Insert returned no row');
			return status(201, serialize(created));
		},
		{
			body: z.object({ title: credentialTitle, value: credentialEnvelope }),
			detail: { summary: 'Create a credential' },
		},
	)
	.get(
		'/:id',
		async ({ params }) => {
			const [result] = await db
				.select(credentialColumns)
				.from(credential)
				.where(eq(credential.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!result) return status(404, { error: 'CREDENTIAL_NOT_FOUND' });
			return serialize(result);
		},
		{
			params: z.object({ id: credentialId }),
			detail: { summary: 'Get a credential' },
		},
	)
	.patch(
		'/:id',
		async ({ body, params }) => {
			if (body.value !== undefined) {
				const inspection = await inspectEnvelope(body.value);
				if (inspection === 'not-decryptable')
					return status(422, { error: 'CREDENTIAL_NOT_DECRYPTABLE' });
				if (inspection === 'too-large')
					return status(422, { error: 'CREDENTIAL_VALUE_TOO_LARGE' });
			}

			// Built explicitly rather than spread: an absent `value` has to leave the
			// stored ciphertext alone, and handing Drizzle a key set to `undefined`
			// is not the same statement as omitting it.
			const changes =
				body.value === undefined
					? { title: body.title }
					: { title: body.title, value: body.value };

			const [updated] = await db
				.update(credential)
				.set(changes)
				.where(eq(credential.id, params.id))
				.returning(credentialColumns);

			if (!updated) return status(404, { error: 'CREDENTIAL_NOT_FOUND' });
			return serialize(updated);
		},
		{
			params: z.object({ id: credentialId }),
			/**
			 * `value` is optional so a client with no secret can still rename: it is
			 * the one operation that does not need to read what it is changing.
			 */
			body: z.object({
				title: credentialTitle,
				value: credentialEnvelope.optional(),
			}),
			detail: { summary: 'Update a credential' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			await db.delete(credential).where(eq(credential.id, params.id));
			return status(204);
		},
		{
			params: z.object({ id: credentialId }),
			detail: { summary: 'Delete a credential' },
		},
	);
