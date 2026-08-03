import { describe, expect, it } from 'bun:test';
import { createSessionRedirect } from '@api/auth';
import { app } from '@api/index';
import { treaty } from '@elysia/eden';

const api = treaty(app);

describe('Health', () => {
	it('reports connected infrastructure', async () => {
		const { data, error, status } = await api.health.get();

		expect(status).toBe(200);
		expect(error).toBeNull();

		if (!data || !('cacheResponse' in data))
			throw new Error('Expected a healthy infrastructure response');

		expect(data?.cacheResponse).toBe('PONG');
		expect(data?.storageResponse).toMatchObject({ name: 'luka' });
	});
});

describe('Authentication', () => {
	it('only accepts the web OAuth callback URL', async () => {
		const [externalOrigin, wrongPath] = await Promise.all([
			api.auth.google.login.get({
				query: { redirect: 'https://example.com/auth/callback' },
			}),
			api.auth.google.login.get({
				query: { redirect: 'http://localhost:5173/not-the-callback' },
			}),
		]);

		expect(externalOrigin.status).toBe(422);
		expect(wrongPath.status).toBe(422);
	});

	it('keeps OAuth tokens out of the redirect query string', () => {
		const redirect = new URL(
			createSessionRedirect(
				'http://localhost:5173/auth/callback?returnTo=%2F',
				{
					at: 'access-token',
					rt: 'refresh-token',
				},
			),
		);

		expect(redirect.searchParams.has('session')).toBeFalse();
		expect(
			new URLSearchParams(redirect.hash.slice(1)).has('session'),
		).toBeTrue();
	});
});
