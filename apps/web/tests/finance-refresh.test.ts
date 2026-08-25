import { useFinanceStore } from '@web/lib/finance-store';
import { financeSystem } from '@web/lib/finance-system';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Finance refreshes from every screen now that the sidebar reads its totals,
 * and that pull owns the quote too — the sidebar has no refresh control of its
 * own, so a rate that only ever loaded on `/finance` would be from whenever the
 * screen was last open.
 *
 * Nothing here is on a timer. The coordinator decides *when*, gated on a sign
 * of life and on age (`system-refresh.test.ts` pins that an untouched app
 * never pulls); this only decides *what* a pull covers once one happens.
 */
afterEach(() => {
	vi.restoreAllMocks();
	useFinanceStore.setState({ quote: undefined, quoteFailed: false });
});

const guard = () => true;

function stubStore(
	load: () => Promise<'loaded' | 'failed'>,
	loadQuote = vi.fn(async () => undefined),
) {
	vi.spyOn(useFinanceStore, 'getState').mockReturnValue({
		...useFinanceStore.getState(),
		load: load as never,
		loadQuote: loadQuote as never,
	});
	return loadQuote;
}

describe('financeSystem.refresh', () => {
	it('pulls the ledger and the quote in the same pass', async () => {
		const loadQuote = stubStore(async () => 'loaded');

		expect(await financeSystem.refresh?.('', guard)).toBe(true);
		expect(loadQuote).toHaveBeenCalledWith(true, guard);
	});

	/**
	 * The quote is a third party on nobody's critical path. Letting it decide the
	 * verdict would put the ledger into backoff because dolarapi is down, and the
	 * store already reports that failure through `quoteFailed`.
	 */
	it('still counts as fresh when only the quote could not be had', async () => {
		stubStore(
			async () => 'loaded',
			vi.fn(async () => {
				useFinanceStore.setState({ quoteFailed: true });
				return undefined;
			}),
		);

		expect(await financeSystem.refresh?.('', guard)).toBe(true);
	});

	it('reports a failed ledger as failed, quote or no quote', async () => {
		stubStore(async () => 'failed');

		expect(await financeSystem.refresh?.('', guard)).toBe(false);
	});

	/** The sidebar reads these totals from every screen, so the pull follows. */
	it('is declared as refreshing everywhere', () => {
		expect(financeSystem.refreshEverywhere).toBe(true);
	});
});
