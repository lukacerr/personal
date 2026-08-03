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

		expect(data?.cacheResponse).toBe('PONG');
		expect(data?.storageResponse).toMatchObject({ name: 'luka' });
	});
});
