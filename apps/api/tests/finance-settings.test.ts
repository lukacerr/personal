import { describe, expect, it } from 'bun:test';
import { cache } from '@api/env';
import {
	createFinanceSettingsStore,
	FINANCE_SETTINGS_KEY,
	type FinanceSettings,
} from '@api/finance-settings';
import { request } from './helpers';

/** A cache stub that records what was written, standing in for Upstash. */
function fakeCache(initial?: unknown) {
	let stored = initial;
	const writes: Array<{ value: unknown; options: unknown }> = [];
	return {
		writes,
		read: () => stored,
		get: async () => stored ?? null,
		set: async (_key: string, value: unknown, options?: unknown) => {
			stored = value;
			writes.push({ value, options });
			return 'OK' as const;
		},
	};
}

const SETTINGS: FinanceSettings = {
	budget: { amount: 3_000_000, currency: 'ars' },
	range: { from: 1_754_006_400_000, toExclusive: 1_756_684_800_000 },
};

describe('shared finance settings', () => {
	it('scopes the key under its own prefix', () => {
		// Drizzle's query cache runs global on this same Redis.
		expect(FINANCE_SETTINGS_KEY).toBe('finance:settings:v1');
	});

	it('reads back what was written', async () => {
		const store = createFinanceSettingsStore({ cache: fakeCache() });
		await store.write(SETTINGS);
		expect(await store.read()).toEqual(SETTINGS);
	});

	/**
	 * Settings are not a derived value that can be recomputed, so they get no
	 * expiry: the whole point is the other device finding them next week.
	 */
	it('stores them without an expiry', async () => {
		const store = createFinanceSettingsStore({ cache: fakeCache() });
		await store.write(SETTINGS);
		expect(store.cache.writes).toHaveLength(1);
		expect(store.cache.writes[0]?.options).toBeUndefined();
	});

	it('reports an empty cache as absent rather than as empty settings', async () => {
		const store = createFinanceSettingsStore({ cache: fakeCache() });
		expect(await store.read()).toBeNull();
	});

	/**
	 * Absent and unreadable are the same answer on purpose: a device that still
	 * has its own copy reseeds the cache instead of adopting a shape this version
	 * cannot make sense of.
	 */
	it('treats an unreadable shape as absent', async () => {
		const store = createFinanceSettingsStore({
			cache: fakeCache({ budget: { amount: -5, currency: 'ars' } }),
		});
		expect(await store.read()).toBeNull();
	});

	/** Clearing a budget has to reach the other devices, so empty is a value. */
	it('keeps an explicitly emptied settings distinct from an absent one', async () => {
		const store = createFinanceSettingsStore({ cache: fakeCache() });
		await store.write({});
		expect(await store.read()).toEqual({});
	});

	it('never lets a cache failure throw at the caller', async () => {
		const store = createFinanceSettingsStore({
			cache: {
				get: async () => {
					throw new Error('redis is down');
				},
				set: async () => {
					throw new Error('redis is down');
				},
			},
		});

		expect(await store.read()).toBeNull();
		expect(await store.write(SETTINGS)).toBe(false);
	});
});

describe('the finance settings endpoints', () => {
	it('round-trips through the real cache', async () => {
		const stored = await request('/payments/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(SETTINGS),
		});
		expect(stored.status).toBe(200);
		expect(await stored.json()).toEqual({ settings: SETTINGS });

		const read = await request('/payments/settings');
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ settings: SETTINGS });

		await cache.del(FINANCE_SETTINGS_KEY);
		const empty = await request('/payments/settings');
		expect(await empty.json()).toEqual({ settings: null });
	});

	it('refuses a budget or a range that cannot mean anything', async () => {
		const body = (payload: unknown) =>
			request('/payments/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});

		expect(
			(await body({ budget: { amount: 0, currency: 'ars' } })).status,
		).toBe(422);
		expect(
			(await body({ budget: { amount: 10, currency: 'eur' } })).status,
		).toBe(422);
		// An inverted window would describe a period that cannot contain anything.
		expect(
			(await body({ range: { from: 20_000, toExclusive: 10_000 } })).status,
		).toBe(422);
		// A timestamp past the `Date` ceiling.
		expect(
			(
				await body({
					range: { from: 8_640_000_000_000_001, toExclusive: null },
				})
			).status,
		).toBe(422);
	});

	/**
	 * The current-month range ends at the first day of the next month, so a
	 * range bound legitimately sits weeks in the future. The clock-skew cap on
	 * sync clocks must never apply to these.
	 */
	it('accepts a range reaching into the future, as the current month does', async () => {
		const response = await request('/payments/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				range: {
					from: Date.now() - 1000,
					toExclusive: Date.now() + 30 * 24 * 60 * 60 * 1000,
				},
			}),
		});

		expect(response.status).toBe(200);
		await cache.del(FINANCE_SETTINGS_KEY);
	});

	it('accepts an open range on either side', async () => {
		const response = await request('/payments/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ range: { from: null, toExclusive: null } }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			settings: { range: { from: null, toExclusive: null } },
		});

		await cache.del(FINANCE_SETTINGS_KEY);
	});
});
