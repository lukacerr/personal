import {
	currentMonthRange,
	filterPayments,
	financeTotals,
	formatPeriodLabel,
	inPeriod,
	parseFinanceView,
	remainingFor,
	sortPayments,
	tagBreakdown,
	toArs,
	toUsd,
	type UsdQuote,
	updateFinanceSearchParams,
} from '@web/lib/finance';
import type { Payment } from '@web/lib/finance-api';
import { describe, expect, it } from 'vitest';

/** A wide spread, so swapping the two sides can never pass unnoticed. */
const QUOTE: UsdQuote = { compra: 1000, venta: 2000 };

const day = (year: number, month: number, date: number) =>
	new Date(year, month, date).getTime();

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
		paidAt: day(2026, 2, 20),
		endedAt: null,
		createdAt: day(2026, 2, 20),
		updatedAt: day(2026, 2, 20),
		...overrides,
	};
}

// 15 March through 14 April inclusive, i.e. [15 Mar, 15 Apr).
const FROM = day(2026, 2, 15);
const TO_EXCLUSIVE = day(2026, 3, 15);

describe('period membership', () => {
	it.each([
		['inside the period', day(2026, 2, 20), true],
		// Half-open on purpose: a closing bound at midnight would otherwise drop
		// everything paid on the last day of the statement.
		['on the first day', FROM, true],
		['on the last day', day(2026, 3, 14), true],
		['the instant the period ends', TO_EXCLUSIVE, false],
		['the day before it starts', day(2026, 2, 14), false],
	])('places a one-off %s', (_case, paidAt, expected) => {
		expect(inPeriod(paymentOf({ paidAt }), FROM, TO_EXCLUSIVE)).toBe(expected);
	});

	it.each([
		['started long before and still running', day(2025, 0, 1), null, true],
		['started inside the period', day(2026, 2, 20), null, true],
		['cancelled inside the period', day(2025, 0, 1), day(2026, 2, 20), true],
		['cancelled before the period', day(2025, 0, 1), day(2026, 1, 1), false],
		['not contracted yet', day(2026, 6, 1), null, false],
	])('places a subscription %s', (_case, paidAt, endedAt, expected) => {
		expect(
			inPeriod(
				paymentOf({ isSubscription: true, paidAt, endedAt }),
				FROM,
				TO_EXCLUSIVE,
			),
		).toBe(expected);
	});

	it.each([
		['no bounds at all', null, null, true],
		['an open start, inside the end', null, TO_EXCLUSIVE, true],
		['an open start, past the end', null, day(2026, 1, 1), false],
		['an open end, after the start', FROM, null, true],
		['an open end, before the start', day(2026, 6, 1), null, false],
	])('places a one-off with %s', (_case, from, toExclusive, expected) => {
		expect(inPeriod(paymentOf(), from, toExclusive)).toBe(expected);
	});

	/** An unbounded range must never hide a subscription behind a null. */
	it('keeps a cancelled subscription visible when the start is open', () => {
		const cancelled = paymentOf({
			isSubscription: true,
			paidAt: day(2024, 0, 1),
			endedAt: day(2024, 6, 1),
		});
		expect(inPeriod(cancelled, null, null)).toBe(true);
		expect(inPeriod(cancelled, FROM, TO_EXCLUSIVE)).toBe(false);
	});

	it('hides subscriptions entirely when they are toggled off', () => {
		const rows = [
			paymentOf({ id: 'sub', isSubscription: true, paidAt: day(2025, 0, 1) }),
			paymentOf({ id: 'once', paidAt: day(2026, 2, 20) }),
		];
		const view = { from: FROM, toExclusive: TO_EXCLUSIVE, query: '', tags: [] };

		expect(
			filterPayments(rows, { ...view, subscriptions: true }).map((r) => r.id),
		).toEqual(['sub', 'once']);
		expect(
			filterPayments(rows, { ...view, subscriptions: false }).map((r) => r.id),
		).toEqual(['once']);
	});

	it('searches title and tag together', () => {
		const rows = [
			paymentOf({ id: 'a', title: 'Movistar', tag: 'Servicios' }),
			paymentOf({ id: 'b', title: 'Carrefour', tag: 'Comida' }),
		];
		const view = {
			from: FROM,
			toExclusive: TO_EXCLUSIVE,
			tags: [],
			subscriptions: true,
		};

		expect(filterPayments(rows, { ...view, query: 'servi' })).toHaveLength(1);
		expect(filterPayments(rows, { ...view, query: 'carre' })).toHaveLength(1);
	});
});

describe('ordering', () => {
	/**
	 * A subscription has no date worth reading in a period it merely overlaps, so
	 * it sinks below the things that actually happened during it.
	 */
	it('puts one-offs first, newest first, and subscriptions after', () => {
		const rows = [
			paymentOf({
				id: 'sub-b',
				tag: 'Bbb',
				isSubscription: true,
				paidAt: day(2025, 0, 1),
			}),
			paymentOf({ id: 'once-old', paidAt: day(2026, 2, 16) }),
			paymentOf({
				id: 'sub-a',
				tag: 'Aaa',
				isSubscription: true,
				paidAt: day(2026, 1, 1),
			}),
			paymentOf({ id: 'once-new', paidAt: day(2026, 2, 28) }),
		];

		expect(sortPayments(rows).map((row) => row.id)).toEqual([
			'once-new',
			'once-old',
			// By tag, not by date: `sub-a` started later than `sub-b`.
			'sub-a',
			'sub-b',
		]);
	});

	/**
	 * A subscription's `paidAt` is when it started, so ordering the recurring
	 * block by it sorts on something nobody is reading. Tag first, because that
	 * is how the block is scanned — all the services together, then the rest.
	 */
	it('orders the recurring block by tag and then by title', () => {
		const sub = (id: string, tag: string | null, title: string) =>
			paymentOf({
				id,
				tag,
				title,
				isSubscription: true,
				// Deliberately the reverse of the expected order, so a leftover
				// date sort cannot pass by accident.
				paidAt: day(2026, 0, 1) + id.charCodeAt(0),
			});

		const rows = [
			sub('e', null, 'Sin tag'),
			sub('d', 'Servicios', 'Movistar'),
			sub('b', 'casa', 'Expense'),
			sub('c', 'Servicios', 'Monot'),
			sub('a', 'Casa', 'Alquiler'),
		];

		expect(sortPayments(rows).map((row) => row.id)).toEqual([
			'a',
			'b',
			'c',
			'd',
			'e',
		]);
	});

	/** Untagged is a residual, not a category, so it never leads the block. */
	it('sinks untagged subscriptions below the tagged ones', () => {
		const rows = [
			paymentOf({ id: 'none', tag: null, isSubscription: true }),
			paymentOf({ id: 'zzz', tag: 'Zzz', isSubscription: true }),
		];
		expect(sortPayments(rows).map((row) => row.id)).toEqual(['zzz', 'none']);
	});

	it('does not mutate the list it was handed', () => {
		const rows = [
			paymentOf({ id: 'sub', isSubscription: true }),
			paymentOf({ id: 'once' }),
		];
		sortPayments(rows);
		expect(rows.map((row) => row.id)).toEqual(['sub', 'once']);
	});
});

describe('the period label', () => {
	it.each([
		[
			'both bounds',
			day(2026, 2, 15),
			day(2026, 3, 15),
			'15 mar – 14 de abr de 2026',
		],
		['no bounds', null, null, 'All time'],
		['only a start', day(2026, 2, 15), null, 'From 15 de mar de 2026'],
		['only an end', null, day(2026, 3, 15), 'Until 14 de abr de 2026'],
	])('reads %s', (_case, from, toExclusive, expected) => {
		expect(formatPeriodLabel({ from, toExclusive })).toBe(expected);
	});
});

describe('the default range', () => {
	/**
	 * There are no arrows and no anchor: a card that opens and closes on
	 * irregular days cannot be derived, so the range is picked by hand and the
	 * only thing worth guessing is the first one.
	 */
	it('opens on the current calendar month when nothing was ever chosen', () => {
		const range = currentMonthRange(day(2026, 2, 20));
		expect(range.from).toBe(day(2026, 2, 1));
		expect(range.toExclusive).toBe(day(2026, 3, 1));
	});

	it('closes the year without rolling into month thirteen', () => {
		const range = currentMonthRange(day(2026, 11, 20));
		expect(range.toExclusive).toBe(day(2027, 0, 1));
	});
});

describe('conversion', () => {
	/**
	 * The spread is not symmetric because the transaction is not: holding those
	 * dollars means buying them at `venta`, and paying those pesos means selling
	 * dollars at `compra`.
	 */
	it('takes dollars to pesos through venta and pesos to dollars through compra', () => {
		const dollars = paymentOf({ currency: 'usd', value: 100 });
		const pesos = paymentOf({ currency: 'ars', value: 100_000 });

		expect(toArs(dollars, QUOTE)).toBe(200_000);
		expect(toUsd(pesos, QUOTE)).toBe(100);
	});

	it('prefers the quote frozen on the row over the live one', () => {
		const row = paymentOf({
			currency: 'usd',
			value: 100,
			rateBuy: 500,
			rateSell: 600,
		});
		expect(toArs(row, QUOTE)).toBe(60_000);
	});

	/** A subscription is re-paid every month, so it costs today's price. */
	it('converts a subscription with the live quote even when it froze one', () => {
		const row = paymentOf({
			currency: 'usd',
			value: 100,
			isSubscription: true,
			rateBuy: 500,
			rateSell: 600,
		});
		expect(toArs(row, QUOTE)).toBe(200_000);
	});

	it('falls back to the live quote when the row never froze one', () => {
		expect(toArs(paymentOf({ currency: 'usd', value: 100 }), QUOTE)).toBe(
			200_000,
		);
	});

	it('reports no conversion rather than a zero when there is no quote at all', () => {
		expect(
			toArs(paymentOf({ currency: 'usd', value: 100 }), undefined),
		).toBeNull();
	});
});

describe('totals', () => {
	it('keeps a row whole in its own currency even with no quote anywhere', () => {
		const totals = financeTotals(
			[paymentOf({ currency: 'ars', value: 500_000 })],
			undefined,
		);

		// A missing quote degrades one number, never both, and never silently
		// turns a real expense into a zero.
		expect(totals.ars).toBe(500_000);
		expect(totals.usd).toBe(0);
		expect(totals.unconvertible).toBe(1);
	});

	it('counts a row converted with the live quote as approximate', () => {
		const totals = financeTotals(
			[paymentOf({ currency: 'ars', value: 100_000 })],
			QUOTE,
		);

		expect(totals.usd).toBe(100);
		expect(totals.approximate).toBe(1);
		expect(totals.unconvertible).toBe(0);
	});

	/**
	 * The two totals travel through different sides of the spread, so no single
	 * rate relates them. Someone will eventually try to "simplify" this into one
	 * total and a division.
	 */
	it('does not make either total derivable from the other', () => {
		const totals = financeTotals(
			[
				paymentOf({
					id: 'a',
					currency: 'usd',
					value: 100,
					rateBuy: 1000,
					rateSell: 2000,
				}),
				paymentOf({
					id: 'b',
					currency: 'ars',
					value: 100_000,
					rateBuy: 400,
					rateSell: 900,
				}),
			],
			QUOTE,
		);

		expect(totals.ars).toBe(200_000 + 100_000);
		expect(totals.usd).toBe(100 + 250);
		expect(totals.ars).not.toBe(totals.usd * QUOTE.venta);
		expect(totals.ars).not.toBe(totals.usd * QUOTE.compra);
	});

	it('separates what recurs every month from what was spent once', () => {
		const totals = financeTotals(
			[
				paymentOf({ id: 'a', value: 100, isSubscription: true }),
				paymentOf({ id: 'b', value: 400 }),
			],
			QUOTE,
		);

		expect(totals.recurringArs).toBe(100);
		expect(totals.oneOffArs).toBe(400);
		expect(totals.ars).toBe(500);
	});
});

describe('remaining against salary', () => {
	/** Narrows the "no salary set" case away, which each test states separately. */
	const withSalary = (
		salary: { amount: number; currency: 'ars' | 'usd' },
		totals: ReturnType<typeof financeTotals>,
	) => {
		const remaining = remainingFor(salary, totals, QUOTE);
		if (!remaining) throw new Error('Expected a remaining for a set salary');
		return remaining;
	};

	/**
	 * Salary converts through the same side as spending. It looks wrong and is
	 * not: `salary − spent` only means something when both were built the same
	 * way, and mixing sides makes the subtraction span two bases.
	 */
	it('converts the salary with the same side of the spread as the spending', () => {
		const totals = financeTotals([], QUOTE);
		const remaining = withSalary({ amount: 3000, currency: 'usd' }, totals);

		expect(remaining.ars).toBe(3000 * QUOTE.venta);
		expect(remaining.usd).toBe(3000);
	});

	it('subtracts the spending of each currency from its own side', () => {
		const totals = financeTotals(
			[paymentOf({ currency: 'ars', value: 1_000_000 })],
			QUOTE,
		);
		const remaining = withSalary({ amount: 3000, currency: 'usd' }, totals);

		expect(remaining.ars).toBe(3000 * QUOTE.venta - 1_000_000);
		expect(remaining.usd).toBe(3000 - 1000);
	});

	it('goes negative rather than clamping at zero', () => {
		const totals = financeTotals(
			[paymentOf({ currency: 'ars', value: 500 })],
			QUOTE,
		);
		const remaining = withSalary({ amount: 100, currency: 'ars' }, totals);

		expect(remaining.ars).toBe(-400);
	});

	it('reports nothing at all when there is no salary set', () => {
		expect(
			remainingFor(undefined, financeTotals([], QUOTE), QUOTE),
		).toBeUndefined();
	});
});

describe('tag breakdown', () => {
	const rows = [
		paymentOf({ id: 'a', tag: 'Comida', value: 300 }),
		paymentOf({ id: 'b', tag: 'comida', value: 200 }),
		paymentOf({ id: 'c', tag: null, value: 100 }),
	];

	it('merges tags that differ only in case, keeping the first spelling', () => {
		const slices = tagBreakdown(rows, QUOTE, 'ars');
		expect(slices[0]).toMatchObject({ label: 'Comida', value: 500 });
	});

	it('collects untagged spending into a single slice', () => {
		const slices = tagBreakdown(rows, QUOTE, 'ars');
		expect(slices.map((slice) => slice.label)).toEqual(['Comida', 'Untagged']);
		expect(slices.at(-1)).toMatchObject({ value: 100 });
	});

	it('sums to the total it is a breakdown of', () => {
		const slices = tagBreakdown(rows, QUOTE, 'ars');
		const total = slices.reduce((sum, slice) => sum + slice.value, 0);
		expect(total).toBe(financeTotals(rows, QUOTE).ars);
	});

	/** A sixth slice would have to reuse a step of the five-token ramp. */
	it('keeps the top four and folds the rest into one slice', () => {
		const many = Array.from({ length: 8 }, (_, index) =>
			paymentOf({
				id: `t${index}`,
				tag: `Tag ${index}`,
				value: (index + 1) * 10,
			}),
		);
		const slices = tagBreakdown(many, QUOTE, 'ars');

		expect(slices).toHaveLength(5);
		expect(slices.map((slice) => slice.value).slice(0, 4)).toEqual([
			80, 70, 60, 50,
		]);
		expect(slices.at(-1)).toMatchObject({
			label: 'Other',
			value: 40 + 30 + 20 + 10,
		});
	});
});

describe('the view in the url', () => {
	const params = (search: string) => new URLSearchParams(search);

	const FALLBACK = { from: day(2026, 1, 10), toExclusive: day(2026, 2, 10) };

	/** The fallback is whatever was last picked, restored from local storage. */
	it('uses the remembered range when the url carries no dates', () => {
		const view = parseFinanceView(params(''), FALLBACK);
		expect(view.from).toBe(FALLBACK.from);
		expect(view.toExclusive).toBe(FALLBACK.toExclusive);
	});

	it('reads an inclusive range and holds it half-open', () => {
		const view = parseFinanceView(
			params('from=2026-03-15&to=2026-04-14'),
			FALLBACK,
		);
		expect(view.from).toBe(day(2026, 2, 15));
		// The url speaks inclusive dates; everything downstream is half-open.
		expect(view.toExclusive).toBe(day(2026, 3, 15));
	});

	it.each([
		['a malformed date', 'from=yesterday&to=2026-04-14'],
		['an inverted range', 'from=2026-04-14&to=2026-03-15'],
	])('ignores %s and falls back', (_case, search) => {
		expect(parseFinanceView(params(search), FALLBACK).from).toBe(FALLBACK.from);
	});

	it('writes a range back as the inclusive dates it read', () => {
		const next = updateFinanceSearchParams(params(''), {
			range: { from: day(2026, 2, 15), toExclusive: day(2026, 3, 15) },
		});
		expect(next.get('from')).toBe('2026-03-15');
		expect(next.get('to')).toBe('2026-04-14');
	});

	it('round-trips the subscriptions toggle and drops it at its default', () => {
		expect(parseFinanceView(params(''), FALLBACK).subscriptions).toBe(true);
		expect(parseFinanceView(params('subs=0'), FALLBACK).subscriptions).toBe(
			false,
		);

		expect(
			updateFinanceSearchParams(params(''), {
				subscriptions: false,
			}).toString(),
		).toBe('subs=0');
		expect(
			updateFinanceSearchParams(params('subs=0'), {
				subscriptions: true,
			}).toString(),
		).toBe('');
	});

	it('keeps defaults out of the url so a plain visit stays plain', () => {
		const next = updateFinanceSearchParams(params(''), {
			query: '',
			tags: [],
			payment: null,
		});
		expect(next.toString()).toBe('');
	});

	/**
	 * The palette can only navigate, so "Add payment" is a link to a url the
	 * screen consumes. It has to survive a round trip and then be cleared, or
	 * every later navigation would reopen the dialog.
	 */
	it.each([
		['only a start', 'from=2026-03-15', day(2026, 2, 15), null],
		['only an end', 'to=2026-04-14', null, day(2026, 3, 15)],
	])('accepts a range with %s', (_case, search, from, toExclusive) => {
		const view = parseFinanceView(params(search), FALLBACK);
		expect(view.from).toBe(from);
		expect(view.toExclusive).toBe(toExclusive);
	});

	it('writes only the bounds that are set', () => {
		const next = updateFinanceSearchParams(params('from=2026-03-15'), {
			range: { from: null, toExclusive: day(2026, 3, 15) },
		});
		expect(next.get('from')).toBeNull();
		expect(next.get('to')).toBe('2026-04-14');
	});

	/**
	 * Clearing both bounds leaves no parameters, so the url alone cannot say
	 * "all time" — the remembered range does, and it is allowed to be open.
	 */
	it('shows everything when the remembered range has no bounds', () => {
		const view = parseFinanceView(params(''), {
			from: null,
			toExclusive: null,
		});
		expect(view.from).toBeNull();
		expect(view.toExclusive).toBeNull();
	});

	it('carries an intent to create, and can clear it again', () => {
		expect(
			updateFinanceSearchParams(params(''), { create: true }).toString(),
		).toBe('new=1');
		expect(
			updateFinanceSearchParams(params('new=1&q=carre'), {
				create: false,
			}).toString(),
		).toBe('q=carre');
	});

	it('changes one concern without discarding the rest of the view', () => {
		const next = updateFinanceSearchParams(params('q=carre&subs=0'), {
			query: 'movi',
		});
		expect(next.get('q')).toBe('movi');
		expect(next.get('subs')).toBe('0');
	});
});
