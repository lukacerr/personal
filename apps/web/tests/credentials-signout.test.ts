// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

/**
 * Signing out on a device being handed back has to take the master secret with
 * it. Everything the API will serve is an envelope that this one string opens,
 * so a wipe that only empties the ciphertext index leaves the whole vault
 * readable to whoever opens DevTools next.
 *
 * The route under test is the shell's `clearLocalSystemData` — the same call the
 * sidebar's sign-out makes. Reaching into the credentials store by hand would
 * pass while the app stayed broken.
 */

/**
 * This happy-dom build exposes no `localStorage`, and the secret store reads
 * `window.localStorage` as its module loads — so the stub must exist before the
 * import. Same gap `auth-refresh.test.ts` works around.
 */
function createMemoryStorage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: (key: string) => entries.get(key) ?? null,
		key: (index: number) => [...entries.keys()][index] ?? null,
		removeItem: (key: string) => void entries.delete(key),
		setItem: (key: string, value: string) =>
			void entries.set(key, String(value)),
	};
}

/**
 * A secret of its own per test. The imported-secret cache is module state that
 * outlives a test, so a shared string would make the first encryption of one
 * test a cache hit from the previous one, and the counts would depend on order.
 */
const secretFor = (test: string) => `signout-secret-0123456789abcdef-${test}`;

let clearLocalSystemData: typeof import('@web/lib/app-systems')['clearLocalSystemData'];
let resumeSessionWork: typeof import('@web/lib/session-work')['resumeSessionWork'];
let encryptCredentialValue: typeof import('@web/lib/credentials-crypto')['encryptCredentialValue'];
let CREDENTIALS_SECRET_KEY: string;
let credentialsSecretSnapshot: typeof import('@web/lib/credentials-secret')['credentialsSecretSnapshot'];
let useCredentialsSecretStore: typeof import('@web/lib/credentials-secret')['useCredentialsSecretStore'];

beforeAll(async () => {
	vi.stubGlobal('localStorage', createMemoryStorage());
	({ clearLocalSystemData } = await import('@web/lib/app-systems'));
	({ resumeSessionWork } = await import('@web/lib/session-work'));
	({ encryptCredentialValue } = await import('@web/lib/credentials-crypto'));
	({
		CREDENTIALS_SECRET_KEY,
		credentialsSecretSnapshot,
		useCredentialsSecretStore,
	} = await import('@web/lib/credentials-secret'));
});

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	resumeSessionWork();
	vi.restoreAllMocks();
});

describe('signing out of the credentials vault', () => {
	it('leaves no master secret on the device', async () => {
		useCredentialsSecretStore.getState().unlock(secretFor('stored'));
		expect(window.localStorage.getItem(CREDENTIALS_SECRET_KEY)).not.toBeNull();

		await clearLocalSystemData();

		expect(window.localStorage.getItem(CREDENTIALS_SECRET_KEY)).toBeNull();
		expect(credentialsSecretSnapshot()).toBeUndefined();
	});

	/**
	 * The imported secret is memoised, so dropping the stored copy is not enough
	 * on its own: live key material left in the module still opens every
	 * envelope the index holds. Observed through `importKey`, which the next
	 * encryption has to call again once the cache is gone.
	 */
	it('drops the key material derived from that secret', async () => {
		const secret = secretFor('signout');
		const importKey = vi.spyOn(crypto.subtle, 'importKey');

		useCredentialsSecretStore.getState().unlock(secret);
		await encryptCredentialValue('first', secret);
		await encryptCredentialValue('second', secret);
		expect(importKey).toHaveBeenCalledTimes(1);

		await clearLocalSystemData();

		await encryptCredentialValue('third', secret);
		expect(importKey).toHaveBeenCalledTimes(2);
	});

	/** Forgetting from the screen is the same rule, reached another way. */
	it('drops both when the screen forgets the secret', async () => {
		const secret = secretFor('forget');
		const importKey = vi.spyOn(crypto.subtle, 'importKey');

		useCredentialsSecretStore.getState().unlock(secret);
		await encryptCredentialValue('first', secret);
		expect(importKey).toHaveBeenCalledTimes(1);

		useCredentialsSecretStore.getState().forget();

		expect(window.localStorage.getItem(CREDENTIALS_SECRET_KEY)).toBeNull();
		expect(credentialsSecretSnapshot()).toBeUndefined();
		await encryptCredentialValue('second', secret);
		expect(importKey).toHaveBeenCalledTimes(2);
	});
});
