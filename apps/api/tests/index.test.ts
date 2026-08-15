import { describe, expect, it } from 'bun:test';
import { db } from '@api/env';
import { app } from '@api/index';
import { treaty } from '@elysia/eden';

const api = treaty(app);

describe('Health', () => {
	it('reports connected infrastructure', async () => {
		const { data, error, status } = await api.health.get();

		expect(status).toBe(200);
		expect(error).toBeNull();

		if (!data || !('services' in data))
			throw new Error('Expected a healthy infrastructure response');

		expect(data.status).toBe('operational');
		expect(data.services.dbCheck).toBe(true);
		expect(data.services.cacheCheck).toBe(true);
		expect(data.services.storageCheck).toBe(true);
	});

	/**
	 * `/health` is anonymous and fans out to Neon, Upstash and R2. A short
	 * in-memory memo caps what a public prober can make this instance spend; the
	 * shared `checkedAt` is the observable proof the fan-out ran once.
	 */
	it('serves repeated probes from a short-lived memo', async () => {
		const first = await api.health.get();
		const second = await api.health.get();

		if (
			!first.data ||
			!('checkedAt' in first.data) ||
			!second.data ||
			!('checkedAt' in second.data)
		)
			throw new Error('Expected two health responses');

		// `toEqual` because Eden's reviver hands `checkedAt` back as a `Date`.
		expect(second.data.checkedAt).toEqual(first.data.checkedAt);
	});
});

describe('Database', () => {
	/**
	 * The drizzle client must receive the schema object itself, not just its
	 * type: with a type-only import the relational API compiles fine but
	 * `db.query.*` is `undefined` at runtime.
	 */
	it('binds the schema at runtime, not only at the type level', () => {
		expect(db.query.payment).toBeDefined();
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
