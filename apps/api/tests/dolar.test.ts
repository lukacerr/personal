import { describe, expect, it } from 'bun:test';
import {
	createUsdRateReader,
	parseDolarQuote,
	USD_RATE_KEY,
	USD_RATE_TTL_SECONDS,
	type UsdQuote,
} from '@api/dolar';

const QUOTE = {
	moneda: 'USD',
	casa: 'oficial',
	nombre: 'Oficial',
	compra: 1470,
	venta: 1520,
	fechaActualizacion: '2026-08-11T11:00:00.000Z',
};

/**
 * A cache stub that records what was written, standing in for Upstash. It holds
 * `unknown` on purpose: what comes back from a shared Redis is not guaranteed to
 * be a quote, and the reader has to survive that.
 */
function fakeCache(initial?: unknown) {
	let stored: unknown = initial;
	const writes: Array<{ value: UsdQuote; ex: number }> = [];
	return {
		writes,
		read: () => stored,
		get: async () => stored,
		set: async (_key: string, value: UsdQuote, options: { ex: number }) => {
			stored = value;
			writes.push({ value, ex: options.ex });
			return 'OK' as const;
		},
	};
}

describe('Dolar quote parsing', () => {
	it('scopes the cached quote under its own prefix', () => {
		// Drizzle's query cache runs global on this same Redis, so this key has to
		// live somewhere it can never collide with.
		expect(USD_RATE_KEY).toBe('finance:usd-rate:v1');
	});

	it('reads both sides of the official quote', () => {
		expect(parseDolarQuote(QUOTE)).toEqual({ compra: 1470, venta: 1520 });
	});

	it('accepts numbers that arrive as strings', () => {
		expect(
			parseDolarQuote({ ...QUOTE, compra: '1470', venta: '1520' }),
		).toEqual({ compra: 1470, venta: 1520 });
	});

	it.each([
		['no compra', { ...QUOTE, compra: undefined }],
		['no venta', { ...QUOTE, venta: undefined }],
		['a zero side', { ...QUOTE, compra: 0 }],
		['a negative side', { ...QUOTE, venta: -1 }],
		['a placeholder string', { ...QUOTE, venta: 'N/A' }],
		['a null side', { ...QUOTE, compra: null }],
		['an absurd magnitude', { ...QUOTE, venta: 1e12 }],
		// compra above venta is not a spread, it is a broken feed.
		['an inverted spread', { ...QUOTE, compra: 1600 }],
		// A repointed endpoint must be refused rather than quietly used: blue and
		// MEP are different numbers and every frozen stamp would inherit them.
		['another casa', { ...QUOTE, casa: 'blue' }],
		['nothing at all', null],
		['a string body', 'oops'],
	])('refuses a quote with %s', (_case, payload) => {
		expect(parseDolarQuote(payload)).toBeUndefined();
	});
});

describe('Usd rate reader', () => {
	const cached: UsdQuote = { compra: 1000, venta: 1100, fetchedAt: 1_000_000 };

	it('serves a fresh cached quote without going out to the network', async () => {
		const cache = fakeCache(cached);
		let calls = 0;
		const read = createUsdRateReader({
			fetchQuote: async () => {
				calls += 1;
				return QUOTE;
			},
			cache,
			now: () => cached.fetchedAt + 60_000,
		});

		expect(await read()).toEqual({ ...cached, stale: false });
		expect(calls).toBe(0);
	});

	it('refetches once the cached quote is past its freshness window', async () => {
		const cache = fakeCache(cached);
		const read = createUsdRateReader({
			fetchQuote: async () => QUOTE,
			cache,
			now: () => cached.fetchedAt + 60 * 60 * 1000,
		});

		expect(await read()).toEqual({
			compra: 1470,
			venta: 1520,
			fetchedAt: cached.fetchedAt + 60 * 60 * 1000,
			stale: false,
		});
		expect(cache.writes).toEqual([
			{
				value: {
					compra: 1470,
					venta: 1520,
					fetchedAt: cached.fetchedAt + 60 * 60 * 1000,
				},
				ex: USD_RATE_TTL_SECONDS,
			},
		]);
	});

	it('falls back to the stale quote and keeps it when the fetch fails', async () => {
		const cache = fakeCache(cached);
		const read = createUsdRateReader({
			fetchQuote: async () => {
				throw new Error('dolarapi is down');
			},
			cache,
			now: () => cached.fetchedAt + 60 * 60 * 1000,
		});

		expect(await read()).toEqual({ ...cached, stale: true });
		// Overwriting on failure would throw away the only quote left.
		expect(cache.writes).toEqual([]);
		expect(cache.read()).toEqual(cached);
	});

	it('treats a garbage body exactly like a network failure', async () => {
		const cache = fakeCache(cached);
		const read = createUsdRateReader({
			fetchQuote: async () => ({ venta: 'N/A' }),
			cache,
			now: () => cached.fetchedAt + 60 * 60 * 1000,
		});

		expect(await read()).toEqual({ ...cached, stale: true });
		expect(cache.writes).toEqual([]);
	});

	/**
	 * Redis is shared infrastructure and its contents are not this module's to
	 * trust: anything that does not parse as a quote is a cache miss, never a
	 * value handed to callers.
	 */
	it('treats an unreadable cached value as a miss and refetches', async () => {
		const cache = fakeCache({ compra: 'garbage', fetchedAt: 5_000 });
		const read = createUsdRateReader({
			fetchQuote: async () => QUOTE,
			cache,
			now: () => 5_000,
		});

		expect(await read()).toEqual({
			compra: 1470,
			venta: 1520,
			fetchedAt: 5_000,
			stale: false,
		});
	});

	it('never serves an unreadable cached value, even with the feed down', async () => {
		const cache = fakeCache({ compra: 1470, venta: 1520, fetchedAt: 'ayer' });
		const read = createUsdRateReader({
			fetchQuote: async () => {
				throw new Error('dolarapi is down');
			},
			cache,
			now: () => 5_000,
		});

		expect(await read()).toBeUndefined();
	});

	it('reports no quote at all rather than inventing one', async () => {
		const cache = fakeCache();
		const read = createUsdRateReader({
			fetchQuote: async () => {
				throw new Error('dolarapi is down');
			},
			cache,
			now: () => 1_000_000,
		});

		expect(await read()).toBeUndefined();
	});
});
