import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { USD_RATE_KEY, USD_RATE_TTL_SECONDS } from '@api/dolar';
import { cache, db } from '@api/env';
import { patchPaymentRow } from '@api/payments';
import { payment } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { eq, inArray } from 'drizzle-orm';
import { json, request } from './helpers';

type PaymentBody = {
	id: string;
	title: string;
	tag: string | null;
	value: number;
	currency: 'ars' | 'usd';
	rateBuy: number | null;
	rateSell: number | null;
	isSubscription: boolean;
	paidAt: number;
	endedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

const createdIds = new Set<string>();

async function create(body: Record<string, unknown>) {
	const response = await json('/payments', 'POST', {
		title: `Expense ${randomUUIDv7()}`,
		value: 1000,
		currency: 'ars',
		...body,
	});
	const parsed = (await response.json()) as PaymentBody;
	if (parsed.id) createdIds.add(parsed.id);
	return { response, body: parsed };
}

/**
 * Seeds the quote the router will stamp with. `DOLARAPI_URL` points at a closed
 * port under test, so whatever is in the cache is the only quote that exists and
 * every rate assertion is deterministic.
 */
async function seedQuote(compra = 1470, venta = 1520) {
	await cache.set(
		USD_RATE_KEY,
		{ compra, venta, fetchedAt: Date.now() },
		{ ex: USD_RATE_TTL_SECONDS },
	);
}

async function storedRow(id: string) {
	const [row] = await db.select().from(payment).where(eq(payment.id, id));
	return row;
}

beforeEach(async () => {
	await seedQuote();
});

afterEach(async () => {
	if (createdIds.size > 0)
		await db.delete(payment).where(inArray(payment.id, [...createdIds]));
	createdIds.clear();
	await cache.del(USD_RATE_KEY);
});

describe('payments', () => {
	it('stamps both sides of the quote the server saw, for either currency', async () => {
		const pesos = await create({ currency: 'ars', value: 508075 });
		const dollars = await create({ currency: 'usd', value: 12.5 });

		expect(pesos.response.status).toBe(201);
		expect(pesos.body).toMatchObject({ rateBuy: 1470, rateSell: 1520 });
		// Both sides even though a peso row only ever divides by `compra`: the row
		// records the observation, and the direction policy lives in the client.
		expect(dollars.body).toMatchObject({ rateBuy: 1470, rateSell: 1520 });
		expect(typeof dollars.body.createdAt).toBe('number');
	});

	it('ignores rates sent by the client', async () => {
		const { body } = await create({ rateBuy: 1, rateSell: 1 });
		expect(body).toMatchObject({ rateBuy: 1470, rateSell: 1520 });
	});

	/**
	 * The most important guarantee in this system: an expense is never lost
	 * because a third-party rate feed was unreachable.
	 */
	it('records the expense with no rate at all when the quote is unavailable', async () => {
		await cache.del(USD_RATE_KEY);

		const { response, body } = await create({ value: 25000 });

		expect(response.status).toBe(201);
		expect(body.value).toBe(25000);
		// Written or left null together: either there was a quote or there was not.
		expect(body.rateBuy).toBeNull();
		expect(body.rateSell).toBeNull();
	});

	it.each([
		['zero', 0],
		['a negative amount', -1],
		['an amount past the column', 1e15],
		['a non-number', 'mucho'],
	])('refuses %s', async (_case, value) => {
		const response = await json('/payments', 'POST', {
			title: 'Bad',
			value,
			currency: 'ars',
		});
		expect(response.status).toBe(422);
	});

	it('rounds a third decimal instead of refusing it', async () => {
		const { body } = await create({ value: 19.999 });
		expect(body.value).toBe(20);
	});

	it('refuses a timestamp Date cannot represent', async () => {
		const response = await json('/payments', 'POST', {
			title: 'Far future',
			value: 10,
			currency: 'ars',
			paidAt: 8_640_000_000_000_001,
		});
		expect(response.status).toBe(422);
	});

	it('keeps paidAt independent of when the row was inserted', async () => {
		const paidAt = Date.UTC(2026, 2, 15, 12);
		const { body } = await create({ paidAt });

		expect(body.paidAt).toBe(paidAt);
		expect(body.createdAt).toBeGreaterThan(paidAt);
	});

	it('refuses an end date on something that is not a subscription', async () => {
		const response = await json('/payments', 'POST', {
			title: 'One-off',
			value: 10,
			currency: 'ars',
			endedAt: Date.now(),
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'PAYMENT_END_REQUIRES_SUBSCRIPTION',
		});
	});

	/**
	 * The client's period predicate branches on `isSubscription` rather than
	 * OR-ing both forms, and those two are only equivalent while this holds: with
	 * `endedAt >= paidAt`, a subscription starting inside a period necessarily
	 * overlaps it. Let an inverted window through and the screen starts hiding
	 * subscriptions that were live.
	 */
	it('refuses a subscription that ends before it started', async () => {
		const paidAt = Date.UTC(2026, 5, 1);
		const response = await json('/payments', 'POST', {
			title: 'Backwards',
			value: 10,
			currency: 'ars',
			isSubscription: true,
			paidAt,
			endedAt: paidAt - 1,
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'PAYMENT_ENDED_BEFORE_PAID',
		});
	});

	it('refuses to patch a subscription into an inverted window', async () => {
		const paidAt = Date.UTC(2026, 5, 1);
		const { body } = await create({ isSubscription: true, paidAt });

		const response = await json(`/payments/${body.id}`, 'PATCH', {
			endedAt: paidAt - 1,
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'PAYMENT_ENDED_BEFORE_PAID',
		});
	});

	/**
	 * The read-merge-write race the PATCH handler cannot see: it validated
	 * against the row it read, but a concurrent write landed before its UPDATE.
	 * The UPDATE re-checks the invariant in its own WHERE over the final values,
	 * so the stale half matches nothing instead of leaving `endedAt` on a row
	 * with `isSubscription = false`. Exercised through the exported statement
	 * because no HTTP interleaving can force this window deterministically.
	 */
	it('refuses the stale half of a race instead of breaking the window invariant', async () => {
		const { body } = await create({
			isSubscription: true,
			paidAt: Date.UTC(2026, 0, 1),
		});

		// What the handler read still said "subscription"; this lands in between:
		await db
			.update(payment)
			.set({ isSubscription: false })
			.where(eq(payment.id, body.id));

		const updated = await patchPaymentRow(body.id, {
			endedAt: Date.UTC(2026, 5, 1),
		});

		expect(updated).toBeUndefined();
		const stored = await storedRow(body.id);
		expect(stored?.endedAt).toBeNull();
	});

	/**
	 * Payment instants are user-chosen dates, not sync clocks: a subscription
	 * cancelled "effective end of month" ends in the future, and the clock-skew
	 * bound that protects LWW systems must not apply here.
	 */
	it('accepts a subscription window that ends in the future', async () => {
		const endedAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
		const { response, body } = await create({
			isSubscription: true,
			paidAt: Date.UTC(2026, 0, 1),
			endedAt,
		});

		expect(response.status).toBe(201);
		expect(body.endedAt).toBe(endedAt);
	});

	it('cancels a subscription by closing its window, keeping the row', async () => {
		const paidAt = Date.UTC(2026, 0, 10);
		const endedAt = Date.UTC(2026, 5, 10);
		const { body } = await create({ isSubscription: true, paidAt });
		expect(body.endedAt).toBeNull();

		const response = await json(`/payments/${body.id}`, 'PATCH', { endedAt });
		expect(response.status).toBe(200);
		expect((await response.json()) as PaymentBody).toMatchObject({
			id: body.id,
			endedAt,
		});
		expect(await storedRow(body.id)).toBeTruthy();
	});

	/**
	 * Stamping today's quote onto a three-month-old row invents a number. Because
	 * both sides are stored, even a currency correction needs no restamp.
	 */
	it('never rewrites the frozen quote, not even when the currency changes', async () => {
		const { body } = await create({ currency: 'ars', value: 1000 });
		await seedQuote(2000, 2100);

		const response = await json(`/payments/${body.id}`, 'PATCH', {
			currency: 'usd',
			value: 10,
		});

		expect(response.status).toBe(200);
		expect((await response.json()) as PaymentBody).toMatchObject({
			currency: 'usd',
			value: 10,
			rateBuy: 1470,
			rateSell: 1520,
		});
	});

	// Conditional reads and tag invalidation live in the `payments index cache`
	// suite below; this test owns only the ordering rule.
	it('lists newest first', async () => {
		const older = await create({ paidAt: Date.UTC(2026, 0, 1) });
		const newer = await create({ paidAt: Date.UTC(2026, 6, 1) });

		const first = await request('/payments');
		expect(first.status).toBe(200);

		const listed = (await first.json()) as PaymentBody[];
		const ids = listed.map((row) => row.id);
		expect(ids.indexOf(newer.body.id)).toBeLessThan(ids.indexOf(older.body.id));
	});

	it('reads one payment and reports an unknown id as missing', async () => {
		const { body } = await create({ tag: 'Servicios' });

		const found = await request(`/payments/${body.id}`);
		expect(found.status).toBe(200);
		expect((await found.json()) as PaymentBody).toMatchObject({
			id: body.id,
			tag: 'Servicios',
		});

		expect((await request(`/payments/${randomUUIDv7()}`)).status).toBe(404);
		expect(
			(await json(`/payments/${randomUUIDv7()}`, 'PATCH', { title: 'x' }))
				.status,
		).toBe(404);
	});

	it('deletes idempotently', async () => {
		const { body } = await create({});

		expect(
			(await request(`/payments/${body.id}`, { method: 'DELETE' })).status,
		).toBe(204);
		expect(
			(await request(`/payments/${body.id}`, { method: 'DELETE' })).status,
		).toBe(204);
		expect(await storedRow(body.id)).toBeUndefined();
		createdIds.delete(body.id);
	});
});

describe('usd rate endpoint', () => {
	it('reports both sides and how fresh they are', async () => {
		const response = await request('/payments/rate');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			compra: 1470,
			venta: 1520,
			stale: false,
		});
	});

	/**
	 * Declared before `/:id`, which parses its parameter as a uuid and would
	 * answer 422 for this path instead.
	 */
	it('answers unavailable rather than pretending, when there is no quote', async () => {
		await cache.del(USD_RATE_KEY);

		const response = await request('/payments/rate');
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'USD_RATE_UNAVAILABLE' });
	});
});

/**
 * The index answers a matching `If-None-Match` from a tag remembered in Redis,
 * so every write path must drop that tag before responding: a poll that gets a
 * 304 for data that changed is worse than no cache at all.
 */
describe('payments index cache', () => {
	async function indexTag() {
		const response = await request('/payments');
		expect(response.status).toBe(200);
		return response.headers.get('etag') ?? '';
	}

	const writes: Array<{
		name: string;
		write: (seeded: PaymentBody) => Promise<(index: PaymentBody[]) => boolean>;
	}> = [
		{
			name: 'recording a payment',
			write: async () => {
				const { body } = await create({});
				return (index) => index.some((row) => row.id === body.id);
			},
		},
		{
			name: 'updating a payment',
			write: async (seeded) => {
				await json(`/payments/${seeded.id}`, 'PATCH', {
					title: 'Renamed after the tag',
				});
				return (index) =>
					index.some(
						(row) =>
							row.id === seeded.id && row.title === 'Renamed after the tag',
					);
			},
		},
		{
			name: 'deleting a payment',
			write: async (seeded) => {
				await request(`/payments/${seeded.id}`, { method: 'DELETE' });
				return (index) => index.every((row) => row.id !== seeded.id);
			},
		},
	];

	for (const entry of writes)
		it(`serves a fresh index after ${entry.name}`, async () => {
			const { body: seeded } = await create({});
			const tag = await indexTag();
			const unchanged = await request('/payments', {
				headers: { 'if-none-match': tag },
			});
			expect(unchanged.status).toBe(304);

			const reflected = await entry.write(seeded);

			const after = await request('/payments', {
				headers: { 'if-none-match': tag },
			});
			expect(after.status).toBe(200);
			expect(reflected((await after.json()) as PaymentBody[])).toBe(true);
		});

	it('treats an unreadable cached tag as a miss', async () => {
		await create({});
		const tag = await indexTag();

		await cache.set('finance:index-tag:v1', { not: 'a tag' });

		// The full read recomputes the tag from the body, which has not changed.
		const conditional = await request('/payments', {
			headers: { 'if-none-match': tag },
		});
		expect(conditional.status).toBe(304);
	});

	it('still answers 304 after the cached tag is evicted', async () => {
		await create({});
		const tag = await indexTag();

		await cache.del('finance:index-tag:v1');

		const conditional = await request('/payments', {
			headers: { 'if-none-match': tag },
		});
		expect(conditional.status).toBe(304);
	});
});
