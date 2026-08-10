import {
	decryptCredentialValue,
	encryptCredentialValue,
} from '@web/lib/credentials-crypto';
import { describe, expect, it } from 'vitest';

/**
 * The known-answer vector shared with the API suite.
 *
 * The algorithm is implemented twice — the web can only import types from the
 * API, never its code — so a fixed vector is the only thing that proves the two
 * halves still agree. This side asserts it *produces* the envelope; the API's
 * `tests/credentials-crypto.test.ts` asserts it can read that exact string back.
 * If either implementation drifts, one of the two suites goes red.
 */
const VECTOR = {
	secret: 'vector-secret-0123456789abcdef0123456789',
	plaintext: '4111 1111 1111 1111',
	salt: new Uint8Array(Array.from({ length: 16 }, (_, index) => index)),
	iv: new Uint8Array(Array.from({ length: 12 }, (_, index) => 16 + index)),
	envelope:
		'v1.AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRob.yu_7kltKqUmXBDkeT6rwm4w0liGjMa5ejSnHEseK2u2SDD4',
};

describe('credential envelopes', () => {
	it('produces the envelope the API expects for the shared vector', async () => {
		expect(
			await encryptCredentialValue(VECTOR.plaintext, VECTOR.secret, {
				salt: VECTOR.salt,
				iv: VECTOR.iv,
			}),
		).toBe(VECTOR.envelope);
	});

	it('reads back its own envelope', async () => {
		const envelope = await encryptCredentialValue(
			'multi\nline\tvalue with émojis 🔑',
			VECTOR.secret,
		);
		expect(await decryptCredentialValue(envelope, VECTOR.secret)).toEqual({
			ok: true,
			value: 'multi\nline\tvalue with émojis 🔑',
		});
	});

	/**
	 * A fresh salt and iv per record is what makes the cheap key derivation safe.
	 * Two credentials holding the same value must not be recognisable as such from
	 * the ciphertext alone.
	 */
	it('never reuses a salt or an iv between two envelopes', async () => {
		const [first, second] = await Promise.all([
			encryptCredentialValue('same', VECTOR.secret),
			encryptCredentialValue('same', VECTOR.secret),
		]);
		expect(first).not.toBe(second);
		expect(first.split('.')[1]).not.toBe(second.split('.')[1]);
		expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
	});

	it('reports a wrong secret instead of throwing', async () => {
		expect(
			await decryptCredentialValue(VECTOR.envelope, 'some-other-secret'),
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
	 * A value that is not an envelope has to be told apart from one that simply
	 * will not open with this secret: the first is a bug or a corrupted row, the
	 * second is a secret the user can fix by typing a different one.
	 */
	it.each(malformed)('rejects %s as malformed', async (_label, raw) => {
		expect(await decryptCredentialValue(raw, VECTOR.secret)).toEqual({
			ok: false,
			reason: 'malformed',
		});
	});
});
