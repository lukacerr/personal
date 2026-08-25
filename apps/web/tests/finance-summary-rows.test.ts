import type { Payment } from '@web/lib/finance-api';
import type { LiveQuote } from '@web/lib/finance-store';
import { financeSummaryRows } from '@web/lib/finance-system';
import { describe, expect, it } from 'vitest';

/** A wide spread, so swapping the two sides can never pass unnoticed. */
const QUOTE: LiveQuote = {
	compra: 1000,
	venta: 2000,
	fetchedAt: 0,
	stale: false,
};

const day = (year: number, month: number, date: number) =>
	new Date(year, month, date).getTime();

const NOW = day(2026, 7, 24);
/** August, which is `NOW`'s month: what an unremembered range falls back to. */
const AUGUST = { from: day(2026, 7, 1), toExclusive: day(2026, 8, 1) };

function paymentOf(overrides: Partial<Payment> = {}): Payment {
	return {
		id: 'p1',
		title: 'Alquiler',
		tag: null,
		value: 1000,
		currency: 'ars',
		rateBuy: null,
		rateSell: null,
		isSubscription: false,
		paidAt: day(2026, 7, 10),
		endedAt: null,
		createdAt: day(2026, 7, 10),
		updatedAt: day(2026, 7, 10),
		...overrides,
	};
}

const detailOf = (rows: ReturnType<typeof financeSummaryRows>, key: string) =>
	rows.find((row) => row.key === key)?.detail;

describe('financeSummaryRows', () => {
	it('says nothing at all when the store never loaded', () => {
		expect(financeSummaryRows([], undefined, {}, NOW)).toEqual([]);
	});

	it('totals the remembered range, not the month around today', () => {
		const july = paymentOf({ id: 'p1', paidAt: day(2026, 6, 10), value: 700 });
		const august = paymentOf({
			id: 'p2',
			paidAt: day(2026, 7, 10),
			value: 900,
		});
		const settings = {
			range: { from: day(2026, 6, 1), toExclusive: day(2026, 7, 1) },
		};

		const rows = financeSummaryRows([july, august], undefined, settings, NOW);
		expect(detailOf(rows, 'ars')).toContain('700');
		expect(detailOf(rows, 'ars')).not.toContain('900');
	});

	it('falls back to the current month for a browser that never picked one', () => {
		const july = paymentOf({ id: 'p1', paidAt: day(2026, 6, 10), value: 700 });
		const august = paymentOf({
			id: 'p2',
			paidAt: day(2026, 7, 10),
			value: 900,
		});

		const rows = financeSummaryRows([july, august], undefined, {}, NOW);
		expect(detailOf(rows, 'ars')).toContain('900');
		expect(detailOf(rows, 'ars')).not.toContain('700');
	});

	/**
	 * A period nobody spent in reads as zero, which is a real answer. Only an
	 * unloaded store has to stay silent.
	 */
	it('reports zero for a range with no payments in it', () => {
		const july = paymentOf({ paidAt: day(2026, 6, 10) });
		const rows = financeSummaryRows([july], undefined, { range: AUGUST }, NOW);
		expect(detailOf(rows, 'ars')).toContain('0');
	});

	/**
	 * The budget's own currency needs no quote to be subtracted, so the row is
	 * always a real number — including when it goes past the budget, which the
	 * sign says on its own without the row having to change colour.
	 */
	it('leaves over what the budget has left, overrun included', () => {
		const spent = paymentOf({ value: 800 });
		const under = financeSummaryRows(
			[spent],
			undefined,
			{ range: AUGUST, budget: { amount: 1000, currency: 'ars' } },
			NOW,
		);
		expect(detailOf(under, 'remaining')).toContain('200');

		const over = financeSummaryRows(
			[spent],
			undefined,
			{ range: AUGUST, budget: { amount: 500, currency: 'ars' } },
			NOW,
		);
		expect(detailOf(over, 'remaining')).toContain('-');
		expect(detailOf(over, 'remaining')).toContain('300');
	});

	it('omits the left over row when no budget was ever set', () => {
		const rows = financeSummaryRows(
			[paymentOf()],
			undefined,
			{ range: AUGUST },
			NOW,
		);
		expect(rows.some((row) => row.key === 'remaining')).toBe(false);
	});

	it('shows both ends of the spread, and no rate row without a quote', () => {
		const withQuote = financeSummaryRows(
			[paymentOf()],
			QUOTE,
			{ range: AUGUST },
			NOW,
		);
		const rate = detailOf(withQuote, 'rate');
		expect(rate).toContain('1.000');
		expect(rate).toContain('2.000');

		const without = financeSummaryRows(
			[paymentOf()],
			undefined,
			{ range: AUGUST },
			NOW,
		);
		expect(without.some((row) => row.key === 'rate')).toBe(false);
	});

	/**
	 * A stale quote is still the last one there was, and it is shown as the
	 * number it is. Nothing here dresses a row differently to editorialise about
	 * it — see `financeTotals` for where an unconvertible row is accounted for.
	 */
	it('shows a stale quote rather than dropping the row', () => {
		const rows = financeSummaryRows(
			[paymentOf()],
			{ ...QUOTE, stale: true },
			{ range: AUGUST },
			NOW,
		);
		expect(detailOf(rows, 'rate')).toContain('1.000');
	});

	it('counts a subscription overlapping the range, as the screen does', () => {
		const netflix = paymentOf({
			isSubscription: true,
			value: 500,
			paidAt: day(2026, 1, 1),
			endedAt: null,
		});
		const rows = financeSummaryRows([netflix], QUOTE, { range: AUGUST }, NOW);
		expect(detailOf(rows, 'ars')).toContain('500');
	});
});
