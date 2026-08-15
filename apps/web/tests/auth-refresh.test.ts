// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@web/lib/env', () => ({
	env: {
		VITE_ENV: 'production',
		VITE_API_URL: 'http://localhost:8080',
		DEV: false,
	},
}));

vi.mock('@web/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@web/lib/api')>();
	return { ...actual, api: { auth: { 'refresh-token': { post } } } };
});

/**
 * This happy-dom build exposes no `localStorage`, and the store binds its
 * persistence to `window.localStorage` when its module loads — so the stub
 * must exist before the store is imported.
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

let useAuthStore: typeof import('@web/lib/auth-store')['useAuthStore'];

beforeAll(async () => {
	vi.stubGlobal('localStorage', createMemoryStorage());
	({ useAuthStore } = await import('@web/lib/auth-store'));
});

const STORAGE_KEY = 'personal-auth:v1';

/** What zustand's persist middleware writes: the real cross-tab contract. */
const persistedEnvelope = (refreshToken: string | null) =>
	JSON.stringify({ state: { refreshToken }, version: 1 });

beforeEach(() => {
	post.mockReset();
	useAuthStore.setState({
		accessToken: null,
		refreshToken: null,
		status: 'booting',
	});
	window.localStorage.clear();
});

/**
 * The refresh token rotates on every refresh, and tabs share one persisted
 * entry but not one memory. The tab holding the dead predecessor must not be
 * able to destroy the session its twin just persisted.
 */
describe('refresh token rotation across tabs', () => {
	it('keeps the session when refresh fails transiently (rate limit)', async () => {
		useAuthStore.setState({ refreshToken: 'rt-live', status: 'authenticated' });
		post.mockResolvedValue({ data: null, error: { status: 429 } });

		await expect(
			useAuthStore.getState().refreshSession(),
		).rejects.toMatchObject({ status: 429 });

		expect(useAuthStore.getState().status).toBe('authenticated');
		expect(useAuthStore.getState().refreshToken).toBe('rt-live');
		expect(window.localStorage.getItem(STORAGE_KEY)).toContain('rt-live');
	});

	it('refreshes with the persisted token when another tab already rotated', async () => {
		useAuthStore.setState({ refreshToken: 'rt-old', status: 'authenticated' });
		window.localStorage.setItem(STORAGE_KEY, persistedEnvelope('rt-new'));
		post.mockResolvedValue({ data: { at: 'at-2', rt: 'rt-2' }, error: null });

		const accessToken = await useAuthStore.getState().refreshSession();

		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith({ refreshToken: 'rt-new' });
		expect(accessToken).toBe('at-2');
		expect(useAuthStore.getState().refreshToken).toBe('rt-2');
	});

	it('adopts a rotation that landed mid-request instead of destroying it', async () => {
		useAuthStore.setState({ refreshToken: 'rt-old', status: 'authenticated' });
		post.mockImplementationOnce(async () => {
			// Another tab rotates and persists while this request is in flight.
			window.localStorage.setItem(STORAGE_KEY, persistedEnvelope('rt-new'));
			return { data: null, error: { status: 401 } };
		});
		post.mockResolvedValueOnce({
			data: { at: 'at-2', rt: 'rt-2' },
			error: null,
		});

		const accessToken = await useAuthStore.getState().refreshSession();

		expect(post).toHaveBeenNthCalledWith(1, { refreshToken: 'rt-old' });
		expect(post).toHaveBeenNthCalledWith(2, { refreshToken: 'rt-new' });
		expect(accessToken).toBe('at-2');
		expect(useAuthStore.getState().status).toBe('authenticated');
		expect(useAuthStore.getState().refreshToken).toBe('rt-2');
	});

	it('clears the session when the rejected token is still the persisted one', async () => {
		useAuthStore.setState({ refreshToken: 'rt-dead', status: 'authenticated' });
		post.mockResolvedValue({ data: null, error: { status: 401 } });

		const accessToken = await useAuthStore.getState().refreshSession();

		expect(accessToken).toBeNull();
		expect(useAuthStore.getState().status).toBe('unauthenticated');
		expect(useAuthStore.getState().refreshToken).toBeNull();
	});
});
