import { cache, env } from '@api/env';
import { z } from 'zod';

/**
 * The official USD quote, and the only third-party call this API makes.
 *
 * Everything except `fetchDolarQuote` is pure or takes its dependencies as
 * arguments, so the whole orchestration — freshness, fallback, what happens when
 * the feed lies — is testable without a network or a Redis.
 */

/** Prefixed so it can never collide with Drizzle's global query cache. */
export const USD_RATE_KEY = 'finance:usd-rate:v1';

/**
 * How long a quote survives in the cache. This is the memory of last resort:
 * with the feed down for a full day the screen still converts, saying how old
 * the number is, rather than showing nothing.
 */
export const USD_RATE_TTL_SECONDS = 24 * 60 * 60;

/** How old a cached quote may be before it is worth another call out. */
export const USD_RATE_FRESH_MS = 30 * 60 * 1000;

/** Longer than this and the caller is better served by yesterday's number. */
const FETCH_TIMEOUT_MS = 2500;

/** Two orders of magnitude above any plausible rate, decimal-point bugs included. */
const MAX_RATE = 100_000_000;

const rate = z.coerce.number().gt(0).max(MAX_RATE);

/**
 * Both sides are required. The screen converts in both directions — pesos into
 * dollars divides by `compra`, dollars into pesos multiplies by `venta` — so
 * half a quote is not a usable quote, and accepting one would stamp rows with a
 * null side that nothing downstream expects.
 */
const dolarQuote = z
	.object({
		compra: rate,
		venta: rate,
		/**
		 * Checked when present so a repointed endpoint — blue, MEP — is refused
		 * instead of quietly becoming the number every future row freezes.
		 */
		casa: z.literal('oficial').optional(),
	})
	.refine(({ compra, venta }) => compra <= venta);

export type UsdQuote = { compra: number; venta: number; fetchedAt: number };
export type UsdRate = UsdQuote & { stale: boolean };

/** The two sides of a response worth believing, or `undefined`. */
export function parseDolarQuote(payload: unknown) {
	const parsed = dolarQuote.safeParse(payload);
	if (!parsed.success) return undefined;
	return { compra: parsed.data.compra, venta: parsed.data.venta };
}

type QuoteCache = {
	get: (key: string) => Promise<UsdQuote | null | undefined>;
	set: (
		key: string,
		value: UsdQuote,
		options: { ex: number },
	) => Promise<unknown>;
};

type RateReaderDependencies = {
	fetchQuote: () => Promise<unknown>;
	cache: QuoteCache;
	now: () => number;
};

/**
 * The read every caller uses.
 *
 * A failed fetch never overwrites what is cached and never throws: the worst
 * answer is a `stale` quote, and the worst of that is `undefined`. Nothing here
 * is allowed to make recording an expense fail.
 */
export function createUsdRateReader({
	fetchQuote,
	cache: store,
	now,
}: RateReaderDependencies) {
	return async function readUsdRate(): Promise<UsdRate | undefined> {
		const cached =
			(await store.get(USD_RATE_KEY).catch(() => undefined)) ?? undefined;
		const at = now();
		if (cached && at - cached.fetchedAt < USD_RATE_FRESH_MS)
			return { ...cached, stale: false };

		const fresh = await fetchQuote().then(parseDolarQuote, () => undefined);
		if (!fresh) return cached ? { ...cached, stale: true } : undefined;

		const quote: UsdQuote = { ...fresh, fetchedAt: at };
		await store
			.set(USD_RATE_KEY, quote, { ex: USD_RATE_TTL_SECONDS })
			.catch(() => undefined);
		return { ...quote, stale: false };
	};
}

/** The only line that touches the network. No test reaches it. */
async function fetchDolarQuote() {
	const response = await fetch(env.DOLARAPI_URL, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`dolarapi answered ${response.status}`);
	return response.json();
}

export const readUsdRate = createUsdRateReader({
	fetchQuote: fetchDolarQuote,
	cache,
	now: () => Date.now(),
});
