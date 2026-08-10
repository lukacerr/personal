import { afterEach, describe, expect, it } from 'bun:test';
import { db, env } from '@api/env';
import { app } from '@api/index';
import { credential } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { eq, inArray, sql } from 'drizzle-orm';

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

/**
 * The client's half of the contract, which the API deliberately does not own.
 *
 * Production code here only ever decrypts, so there is no `encryptCredentialValue`
 * to import — writing one into `src` just to be called from a test is exactly the
 * dead export the repo's testing rules warn about. This stands in for the browser,
 * and if it ever drifts from the real algorithm every write test goes red on the
 * spot, which is the only guarantee it needs to offer.
 */
async function encryptAsClient(plaintext: string, secret: string) {
	const encoder = new TextEncoder();
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		'HKDF',
		false,
		['deriveKey'],
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt,
			info: encoder.encode('personal:credential:v1'),
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt'],
	);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			encoder.encode(plaintext),
		),
	);
	const segment = (bytes: Uint8Array) =>
		Buffer.from(bytes).toString('base64url');
	return ['v1', segment(salt), segment(iv), segment(ciphertext)].join('.');
}

const sealed = (plaintext: string) =>
	encryptAsClient(plaintext, env.LUKA_SECRET);

const createdIds = new Set<string>();
/** Unique per run: the table rejects duplicate titles and the database is real. */
const uniqueTitle = (label: string) => `${label} ${randomUUIDv7()}`;

type CredentialBody = {
	id: string;
	title: string;
	value: string;
	createdAt: number;
	updatedAt: number;
};

async function create(title: string, plaintext = 'hunter2') {
	const response = await json('/credentials', 'POST', {
		title,
		value: await sealed(plaintext),
	});
	const body = (await response.json()) as CredentialBody;
	createdIds.add(body.id);
	return { response, body };
}

async function storedValue(id: string) {
	const [row] = await db
		.select({ value: credential.value })
		.from(credential)
		.where(eq(credential.id, id))
		.$withCache(false);
	return row?.value;
}

afterEach(async () => {
	if (createdIds.size > 0)
		await db.delete(credential).where(inArray(credential.id, [...createdIds]));
	createdIds.clear();
});

describe('credentials', () => {
	it('stores the envelope exactly as it arrived and never a plaintext', async () => {
		const envelope = await sealed('4111 1111 1111 1111');
		const response = await json('/credentials', 'POST', {
			title: uniqueTitle('Card'),
			value: envelope,
		});
		const body = (await response.json()) as CredentialBody;
		createdIds.add(body.id);

		expect(response.status).toBe(201);
		expect(body.value).toBe(envelope);
		expect(await storedValue(body.id)).toBe(envelope);
		expect(body.value).not.toContain('4111');
		expect(typeof body.createdAt).toBe('number');
		expect(typeof body.updatedAt).toBe('number');
	});

	/**
	 * The write-time check is what makes an unreadable row impossible. A client
	 * holding the wrong secret would otherwise write something nobody can ever
	 * decrypt, and the loss would only surface the day someone needed the value.
	 */
	it('rejects an envelope sealed with a different secret and stores nothing', async () => {
		const title = uniqueTitle('Foreign');
		const response = await json('/credentials', 'POST', {
			title,
			value: await encryptAsClient('hunter2', 'a-completely-different-secret'),
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'CREDENTIAL_NOT_DECRYPTABLE',
		});

		const [{ count }] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(credential)
			.where(eq(credential.title, title))
			.$withCache(false);
		expect(count).toBe(0);
	});

	it('rejects a value that is not an envelope at all', async () => {
		const response = await json('/credentials', 'POST', {
			title: uniqueTitle('Plain'),
			value: 'just-a-plaintext-someone-forgot-to-encrypt',
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'CREDENTIAL_NOT_DECRYPTABLE',
		});
	});

	/**
	 * The size bound has to be checked on the plaintext, not the envelope: the
	 * ciphertext length is the client's arithmetic, and bounding only that leaves
	 * the real limit unstated.
	 */
	it('rejects a plaintext over the size limit even inside a valid envelope', async () => {
		const response = await json('/credentials', 'POST', {
			title: uniqueTitle('Huge'),
			value: await sealed('x'.repeat(4097)),
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'CREDENTIAL_VALUE_TOO_LARGE',
		});
	});

	it('accepts a plaintext exactly at the size limit', async () => {
		const { response } = await create(uniqueTitle('AtLimit'), 'x'.repeat(4096));
		expect(response.status).toBe(201);
	});

	it('refuses a title another credential already uses, ignoring case', async () => {
		const title = uniqueTitle('Duplicate');
		await create(title);

		const response = await json('/credentials', 'POST', {
			title: title.toUpperCase(),
			value: await sealed('hunter2'),
		});
		expect(response.status).toBe(409);
	});

	it('lists credentials and revalidates with an entity tag', async () => {
		const { body } = await create(uniqueTitle('Listed'));

		const first = await request('/credentials');
		const tag = first.headers.get('etag');
		expect(first.status).toBe(200);
		expect(tag).toBeTruthy();
		expect((await first.json()) as CredentialBody[]).toContainEqual(
			expect.objectContaining({ id: body.id }),
		);

		const repeated = await request('/credentials', {
			headers: { 'if-none-match': tag ?? '' },
		});
		expect(repeated.status).toBe(304);
		expect(await repeated.text()).toBe('');

		await json(`/credentials/${body.id}`, 'PATCH', {
			title: uniqueTitle('Renamed'),
		});
		const afterChange = await request('/credentials', {
			headers: { 'if-none-match': tag ?? '' },
		});
		expect(afterChange.status).toBe(200);
	});

	it('reads one credential and reports an unknown id as missing', async () => {
		const { body } = await create(uniqueTitle('Readable'));

		const found = await request(`/credentials/${body.id}`);
		expect(found.status).toBe(200);
		expect((await found.json()) as CredentialBody).toMatchObject({
			id: body.id,
			value: body.value,
		});

		const missing = await request(`/credentials/${randomUUIDv7()}`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: 'CREDENTIAL_NOT_FOUND' });
	});

	/**
	 * The one operation that survives a locked client: renaming needs no secret,
	 * so omitting `value` has to leave the ciphertext untouched rather than
	 * blanking it or demanding a round trip through a decryption nobody can do.
	 */
	it('renames without a value and leaves the ciphertext byte for byte', async () => {
		const { body } = await create(uniqueTitle('Renameable'), 'keep-me');
		const before = await storedValue(body.id);

		const response = await json(`/credentials/${body.id}`, 'PATCH', {
			title: uniqueTitle('Renamed'),
		});
		expect(response.status).toBe(200);
		expect(await storedValue(body.id)).toBe(before);
	});

	it('replaces the ciphertext when a value is sent', async () => {
		const { body } = await create(uniqueTitle('Replaceable'), 'old');
		const replacement = await sealed('new');

		const response = await json(`/credentials/${body.id}`, 'PATCH', {
			title: body.title,
			value: replacement,
		});
		expect(response.status).toBe(200);
		expect(await storedValue(body.id)).toBe(replacement);
	});

	it('rejects an update whose envelope cannot be decrypted', async () => {
		const { body } = await create(uniqueTitle('Guarded'), 'keep-me');
		const before = await storedValue(body.id);

		const response = await json(`/credentials/${body.id}`, 'PATCH', {
			title: body.title,
			value: await encryptAsClient('new', 'a-completely-different-secret'),
		});
		expect(response.status).toBe(422);
		expect(await storedValue(body.id)).toBe(before);
	});

	it('reports an update to an unknown credential as missing', async () => {
		const response = await json(`/credentials/${randomUUIDv7()}`, 'PATCH', {
			title: uniqueTitle('Ghost'),
		});
		expect(response.status).toBe(404);
	});

	it('deletes idempotently', async () => {
		const { body } = await create(uniqueTitle('Deletable'));

		const first = await request(`/credentials/${body.id}`, {
			method: 'DELETE',
		});
		expect(first.status).toBe(204);

		const second = await request(`/credentials/${body.id}`, {
			method: 'DELETE',
		});
		expect(second.status).toBe(204);

		expect(await storedValue(body.id)).toBeUndefined();
	});
});
