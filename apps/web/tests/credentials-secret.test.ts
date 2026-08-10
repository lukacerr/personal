import {
	CREDENTIALS_SECRET_KEY,
	clearCredentialsSecret,
	loadCredentialsSecret,
	saveCredentialsSecret,
} from '@web/lib/credentials-secret';
import { describe, expect, it } from 'vitest';

/**
 * A fake store rather than a DOM: the gate's contract is `Storage`, and injecting
 * one keeps these tests out of an environment they do not need.
 */
function memoryStorage(initial?: string) {
	let value = initial ?? null;
	return {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
		removeItem: () => {
			value = null;
		},
		read: () => value,
	};
}

describe('the credentials secret gate', () => {
	it('round-trips a secret through storage', () => {
		const storage = memoryStorage();
		saveCredentialsSecret(storage, 'a-very-long-and-random-looking-secret');
		expect(loadCredentialsSecret(storage)).toBe(
			'a-very-long-and-random-looking-secret',
		);
	});

	it('stores the secret under a versioned key', () => {
		const storage = memoryStorage();
		saveCredentialsSecret(storage, 'secret');
		expect(CREDENTIALS_SECRET_KEY).toBe('personal-credentials-secret:v1');
		expect(JSON.parse(storage.read() ?? '')).toEqual({
			version: 1,
			secret: 'secret',
		});
	});

	it('forgets the secret', () => {
		const storage = memoryStorage();
		saveCredentialsSecret(storage, 'secret');
		clearCredentialsSecret(storage);
		expect(loadCredentialsSecret(storage)).toBeUndefined();
	});

	/**
	 * Anything unreadable leaves the app locked rather than half-unlocked with a
	 * broken secret: a value that cannot be parsed is not a secret, and treating
	 * it as one would show a screenful of rows that all fail to decrypt.
	 */
	const unusable: Array<[string, string | undefined]> = [
		['nothing stored', undefined],
		['a value that is not JSON', 'not-json'],
		['a future version', JSON.stringify({ version: 2, secret: 'secret' })],
		['a missing secret', JSON.stringify({ version: 1 })],
		['an empty secret', JSON.stringify({ version: 1, secret: '' })],
		['a secret of the wrong type', JSON.stringify({ version: 1, secret: 42 })],
	];

	it.each(unusable)('stays locked given %s', (_label, stored) => {
		expect(loadCredentialsSecret(memoryStorage(stored))).toBeUndefined();
	});

	it('survives a storage that refuses to write', () => {
		expect(() =>
			saveCredentialsSecret(
				{
					setItem: () => {
						throw new Error('QuotaExceededError');
					},
				},
				'secret',
			),
		).not.toThrow();
	});
});
