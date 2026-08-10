import { describe, expect, it } from 'bun:test';
import { decryptCredentialValue } from '@api/credentials-crypto';

/**
 * The known-answer vector shared with the web suite.
 *
 * The algorithm is implemented twice — once per workspace, because the web can
 * only import types from the API — so nothing but a fixed vector proves the two
 * halves still agree. `apps/web/tests/credentials-crypto.test.ts` asserts it
 * *produces* this exact envelope; this side asserts it can read it back. If
 * either implementation drifts, one of the two suites goes red.
 */
export const VECTOR = {
	secret: 'vector-secret-0123456789abcdef0123456789',
	plaintext: '4111 1111 1111 1111',
	envelope:
		'v1.AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRob.yu_7kltKqUmXBDkeT6rwm4w0liGjMa5ejSnHEseK2u2SDD4',
};

describe('credential envelopes', () => {
	it('reads back the envelope the web produces for the shared vector', async () => {
		expect(
			await decryptCredentialValue(VECTOR.envelope, VECTOR.secret),
		).toEqual({ ok: true, value: VECTOR.plaintext });
	});

	/**
	 * A wrong secret and a tampered ciphertext are the same failure to AES-GCM —
	 * an authentication tag that does not verify. Both have to come back as a
	 * result rather than a thrown `OperationError`, because the caller is an HTTP
	 * handler that owes the client a status code.
	 */
	it('reports an undecryptable envelope instead of throwing', async () => {
		expect(
			await decryptCredentialValue(VECTOR.envelope, 'some-other-secret'),
		).toEqual({ ok: false, reason: 'undecryptable' });
	});

	it('reports a tampered ciphertext as undecryptable', async () => {
		const [version, salt, iv, ciphertext] = VECTOR.envelope.split('.');
		const flipped = `${ciphertext.slice(0, -1)}${ciphertext.at(-1) === 'A' ? 'B' : 'A'}`;
		expect(
			await decryptCredentialValue(
				[version, salt, iv, flipped].join('.'),
				VECTOR.secret,
			),
		).toEqual({ ok: false, reason: 'undecryptable' });
	});

	const malformed: Array<[string, string]> = [
		['an empty string', ''],
		[
			'a missing ciphertext segment',
			'v1.AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRob',
		],
		['an extra segment', `${VECTOR.envelope}.EBESExQVFhcYGRob`],
		['an unknown version prefix', VECTOR.envelope.replace('v1.', 'v2.')],
		[
			'a salt of the wrong length',
			VECTOR.envelope.replace('AAECAwQFBgcICQoLDA0ODw', 'AAECAwQFBgcICQoL'),
		],
		[
			'an iv of the wrong length',
			VECTOR.envelope.replace('EBESExQVFhcYGRob', 'EBESExQVFhcY'),
		],
		[
			'characters outside base64url',
			VECTOR.envelope.replace('EBESExQVFhcYGRob', 'EBESExQVFhcYGR+/'),
		],
	];

	/**
	 * `Buffer.from(value, 'base64url')` silently drops anything it does not
	 * recognise, so a segment has to be checked before it is decoded rather than
	 * after: without that, padding characters or stray symbols decode to a
	 * shorter buffer and the envelope looks merely undecryptable when it is
	 * actually not an envelope at all.
	 */
	it.each(malformed)('rejects %s as malformed', async (_label, raw) => {
		expect(await decryptCredentialValue(raw, VECTOR.secret)).toEqual({
			ok: false,
			reason: 'malformed',
		});
	});
});
