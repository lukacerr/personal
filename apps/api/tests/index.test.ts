import { describe, expect, it } from 'bun:test';
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

		expect(data.cacheResponse).toBe('PONG');
		expect(data.storageResponse).toMatchObject({ name: 'luka' });
	});
});

describe('OAuth', () => {
	it('sets localhost-compatible state cookies outside production', async () => {
		const redirect = encodeURIComponent(
			'http://localhost:5173/auth/callback?returnTo=%2F',
		);
		const response = await app.handle(
			new Request(`http://localhost/auth/google/login?redirect=${redirect}`),
		);
		const cookies = response.headers.getSetCookie();

		expect(response.status).toBe(302);
		expect(cookies).toHaveLength(2);
		for (const cookie of cookies) {
			expect(cookie).toContain('HttpOnly');
			expect(cookie).toContain('SameSite=Lax');
			expect(cookie).not.toContain('Secure');
		}
	});
});
