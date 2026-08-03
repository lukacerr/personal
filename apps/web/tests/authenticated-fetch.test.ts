import {
	createAuthenticatedFetch,
	type Fetcher,
} from '@web/lib/authenticated-fetch';
import { describe, expect, it, vi } from 'vitest';

describe('Authenticated requests', () => {
	it('retries a 401 once with a rotated access token', async () => {
		let accessToken = 'expired-token';
		const authorizationHeaders: Array<string | null> = [];
		const fetcher: Fetcher = async (_input, init) => {
			authorizationHeaders.push(
				new Headers(init?.headers).get('authorization'),
			);

			return new Response(null, {
				status: authorizationHeaders.length === 1 ? 401 : 200,
			});
		};
		const refreshAccessToken = vi.fn(async () => {
			accessToken = 'renewed-token';
			return accessToken;
		});
		const onUnauthorized = vi.fn();
		const authenticatedFetch = createAuthenticatedFetch({
			fetcher,
			getAccessToken: () => accessToken,
			refreshAccessToken,
			onUnauthorized,
		});

		const response = await authenticatedFetch('http://localhost/private');

		expect(response.status).toBe(200);
		expect(authorizationHeaders).toEqual([
			'Bearer expired-token',
			'Bearer renewed-token',
		]);
		expect(refreshAccessToken).toHaveBeenCalledOnce();
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	it('ends the session when refreshing fails', async () => {
		const onUnauthorized = vi.fn();
		const authenticatedFetch = createAuthenticatedFetch({
			fetcher: async () => new Response(null, { status: 401 }),
			getAccessToken: () => 'expired-token',
			refreshAccessToken: async () => null,
			onUnauthorized,
		});

		const response = await authenticatedFetch('http://localhost/private');

		expect(response.status).toBe(401);
		expect(onUnauthorized).toHaveBeenCalledOnce();
	});

	it('preserves the session when the refresh request cannot reach the API', async () => {
		const onUnauthorized = vi.fn();
		const authenticatedFetch = createAuthenticatedFetch({
			fetcher: async () => new Response(null, { status: 401 }),
			getAccessToken: () => 'expired-token',
			refreshAccessToken: async () => {
				throw new TypeError('Network unavailable');
			},
			onUnauthorized,
		});

		const response = await authenticatedFetch('http://localhost/private');

		expect(response.status).toBe(401);
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	it('shares one refresh across concurrent unauthorized requests', async () => {
		let accessToken = 'expired-token';
		const fetcher: Fetcher = async (_input, init) =>
			new Response(null, {
				status:
					new Headers(init?.headers).get('authorization') ===
					'Bearer renewed-token'
						? 200
						: 401,
			});
		const refreshAccessToken = vi.fn(async () => {
			await Promise.resolve();
			accessToken = 'renewed-token';
			return accessToken;
		});
		const authenticatedFetch = createAuthenticatedFetch({
			fetcher,
			getAccessToken: () => accessToken,
			refreshAccessToken,
			onUnauthorized: vi.fn(),
		});

		const responses = await Promise.all([
			authenticatedFetch('http://localhost/private-a'),
			authenticatedFetch('http://localhost/private-b'),
		]);

		expect(responses.map(({ status }) => status)).toEqual([200, 200]);
		expect(refreshAccessToken).toHaveBeenCalledOnce();
	});
});
