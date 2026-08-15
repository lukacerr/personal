import type { Payment } from '@web/lib/finance-api';
import type { FinanceBudget } from '@web/lib/finance-settings';
import { isBareLetterShortcut, type ShortcutEvent } from '@web/lib/keyboard';

/**
 * Everything Finance knows how to compute, with no React, no network and no
 * storage in sight. Periods, the spread, the totals and the shareable view all
 * live here so they can be reasoned about — and tested — on their own.
 */

export type UsdQuote = { compra: number; venta: number };

/** The bare letter opens the payment form; Ctrl/Cmd+A stays select all. */
export function isAddPaymentShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'a');
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A half-open range: a closing bound at midnight would drop everything paid on
 * the statement's last day.
 *
 * There is deliberately no anchor day and no stepping. A credit card statement
 * that opens and closes on irregular dates, with no fixed length, cannot be
 * derived from one number — trying to made the arrows lie about which period
 * they were showing. The range is picked by hand and remembered, and the only
 * thing worth guessing is the very first one.
 */
export type DateRange = {
	/** `null` means unbounded on that side: everything before, or ever since. */
	from: number | null;
	toExclusive: number | null;
};

/** The opening guess, for a browser that has never picked a range. */
export function currentMonthRange(now: number): DateRange {
	const date = new Date(now);
	return {
		from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
		// Month 12 rolls into January of the next year on its own.
		toExclusive: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
	};
}

/* -------------------------------------------------------------------------- */
/* Membership                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A one-off belongs to the period it was paid in. A subscription is not a point
 * but a window, so it belongs to every period its window overlaps — which is
 * what makes it show up outside the dates on screen.
 *
 * Branching on `isSubscription` is equivalent to OR-ing both forms only because
 * the API guarantees `endedAt >= paidAt`: with that, a subscription starting
 * inside the period necessarily overlaps it.
 */
export function inPeriod(
	row: Payment,
	from: number | null,
	toExclusive: number | null,
) {
	// An absent bound is not a boundary at zero: it means there is none.
	const startedInTime = toExclusive === null || row.paidAt < toExclusive;
	if (!row.isSubscription)
		return startedInTime && (from === null || row.paidAt >= from);
	return (
		startedInTime &&
		(row.endedAt === null || from === null || row.endedAt >= from)
	);
}

export type FinanceFilter = {
	from: number | null;
	toExclusive: number | null;
	query: string;
	tags: string[];
	subscriptions: boolean;
};

export function filterPayments(rows: Payment[], filter: FinanceFilter) {
	const needle = filter.query.trim().toLocaleLowerCase();
	const wanted = new Set(filter.tags.map((tag) => tag.toLocaleLowerCase()));

	return rows.filter((row) => {
		if (row.isSubscription && !filter.subscriptions) return false;
		if (!inPeriod(row, filter.from, filter.toExclusive)) return false;
		if (wanted.size > 0 && !wanted.has((row.tag ?? '').toLocaleLowerCase()))
			return false;
		if (!needle) return true;
		return (
			row.title.toLocaleLowerCase().includes(needle) ||
			(row.tag?.toLocaleLowerCase().includes(needle) ?? false)
		);
	});
}

/**
 * Reading order for the list: what happened during the period first, newest
 * first, and the recurring charges after it.
 *
 * The two blocks sort by different things because they are read differently.
 * A one-off is an event, so its date is the point. A subscription's `paidAt` is
 * only when it started — in any period it merely overlaps, that date says
 * nothing, and the list hides it — so the recurring block is grouped by tag and
 * then alphabetically, which is how you scan it: all the services together,
 * then the rest.
 *
 * Neither block sorts by amount: comparing two currencies would need a quote,
 * and the order would reshuffle every time the dollar moved.
 */
export function sortPayments(rows: Payment[]) {
	// Case-insensitive, so "Casa" and "casa" land together here exactly as they
	// merge in the breakdown. Untagged is a residual and sinks below the rest.
	const byTag = (a: Payment, b: Payment) => {
		if (!a.tag && !b.tag) return 0;
		if (!a.tag) return 1;
		if (!b.tag) return -1;
		return a.tag.toLocaleLowerCase().localeCompare(b.tag.toLocaleLowerCase());
	};

	return [...rows].sort((a, b) => {
		if (a.isSubscription !== b.isSubscription) return a.isSubscription ? 1 : -1;
		if (!a.isSubscription) return b.paidAt - a.paidAt;
		return byTag(a, b) || a.title.localeCompare(b.title);
	});
}

/** Every tag present, once, for the filter to offer. */
export function collectTags(rows: Payment[]) {
	const seen = new Map<string, string>();
	for (const row of rows) {
		if (!row.tag) continue;
		const key = row.tag.toLocaleLowerCase();
		if (!seen.has(key)) seen.set(key, row.tag);
	}
	return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------------------------------- */
/* Conversion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One policy, applied to everything on screen.
 *
 *   USD → ARS  × venta   — holding those dollars means buying them
 *   ARS → USD  ÷ compra  — paying those pesos means selling dollars
 *
 * The spread is asymmetric because the transaction is. The budget goes through
 * the same two sides on purpose (see `remainingFor`).
 *
 * A subscription always converts with the live quote: it is re-paid every month
 * at today's price, so the quote frozen the day it was first recorded describes
 * a payment that is years old.
 */
const buyRate = (row: Payment, live: UsdQuote | undefined) =>
	row.isSubscription ? live?.compra : (row.rateBuy ?? live?.compra);

const sellRate = (row: Payment, live: UsdQuote | undefined) =>
	row.isSubscription ? live?.venta : (row.rateSell ?? live?.venta);

/** The row in pesos, or `null` when no quote can convert it. */
export function toArs(row: Payment, live: UsdQuote | undefined) {
	if (row.currency === 'ars') return row.value;
	const rate = sellRate(row, live);
	return rate === undefined ? null : row.value * rate;
}

/** The row in dollars, or `null` when no quote can convert it. */
export function toUsd(row: Payment, live: UsdQuote | undefined) {
	if (row.currency === 'usd') return row.value;
	const rate = buyRate(row, live);
	return rate === undefined ? null : row.value / rate;
}

/** Whether the row had to borrow the live quote instead of using its own. */
const isApproximate = (row: Payment) =>
	!row.isSubscription && row.rateBuy === null && row.rateSell === null;

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

export type FinanceTotals = {
	ars: number;
	usd: number;
	/** Rows the live quote had to cover because they never froze one. */
	approximate: number;
	/** Rows no quote could convert. Shown, never folded into the total as zero. */
	unconvertible: number;
	recurringArs: number;
	oneOffArs: number;
	count: number;
	subscriptions: number;
};

/**
 * A row is never dropped from the total of its own currency: a peso expense
 * counts in full in pesos even with no quote anywhere, and only its dollar
 * equivalent goes missing. A missing quote degrades one number, never two, and
 * never silently turns a real expense into a zero.
 */
export function financeTotals(
	rows: Payment[],
	live: UsdQuote | undefined,
): FinanceTotals {
	const totals: FinanceTotals = {
		ars: 0,
		usd: 0,
		approximate: 0,
		unconvertible: 0,
		recurringArs: 0,
		oneOffArs: 0,
		count: rows.length,
		subscriptions: 0,
	};

	for (const row of rows) {
		const ars = toArs(row, live);
		const usd = toUsd(row, live);

		if (ars !== null) {
			totals.ars += ars;
			if (row.isSubscription) totals.recurringArs += ars;
			else totals.oneOffArs += ars;
		}
		if (usd !== null) totals.usd += usd;
		if (row.isSubscription) totals.subscriptions += 1;

		if (ars === null || usd === null) totals.unconvertible += 1;
		else if (isApproximate(row)) totals.approximate += 1;
	}

	return totals;
}

export type FinanceRemaining = { ars: number | null; usd: number | null };

/**
 * What is left of the budget once the period is paid for.
 *
 * The budget converts through the same side of the spread as the spending, not
 * the mirrored one. It reads like a bug and is not: `budget − spent` only means
 * something when both numbers were built the same way, and pricing the budget
 * as "dollars I would sell" while pricing expenses as "dollars I must buy"
 * makes the subtraction span two different bases.
 */
export function remainingFor(
	budget: FinanceBudget | undefined,
	totals: FinanceTotals,
	live: UsdQuote | undefined,
): FinanceRemaining | undefined {
	if (!budget) return undefined;

	const ars =
		budget.currency === 'ars'
			? budget.amount
			: live && budget.amount * live.venta;
	const usd =
		budget.currency === 'usd'
			? budget.amount
			: live && budget.amount / live.compra;

	return {
		ars: ars === undefined ? null : ars - totals.ars,
		usd: usd === undefined ? null : usd - totals.usd,
	};
}

/* -------------------------------------------------------------------------- */
/* Breakdown by tag                                                            */
/* -------------------------------------------------------------------------- */

export type TagSlice = { key: string; label: string; value: number };

/**
 * Four named tags plus "Other" fills `--chart-1..5` exactly. A sixth slice would
 * have to reuse a step, and two slices the same colour is worse than a tail
 * nobody itemised.
 */
const MAX_SLICES = 4;

export const UNTAGGED_LABEL = 'Untagged';
export const OTHER_LABEL = 'Other';

/**
 * One currency at a time: a pie mixing pesos and dollars adds numbers that do
 * not share a unit. Case-variant tags merge, because "Comida" and "comida" are
 * one category everywhere except in a `Map`.
 */
export function tagBreakdown(
	rows: Payment[],
	live: UsdQuote | undefined,
	currency: 'ars' | 'usd',
): TagSlice[] {
	const grouped = new Map<string, TagSlice>();

	for (const row of rows) {
		const amount = currency === 'ars' ? toArs(row, live) : toUsd(row, live);
		if (amount === null) continue;

		const key = row.tag?.toLocaleLowerCase() ?? '';
		const existing = grouped.get(key);
		if (existing) existing.value += amount;
		else
			grouped.set(key, {
				key,
				label: row.tag ?? UNTAGGED_LABEL,
				value: amount,
			});
	}

	const slices = [...grouped.values()]
		.filter((slice) => slice.value > 0)
		.sort((a, b) => b.value - a.value);

	// Untagged is a residual, not a category, so it never outranks a real tag.
	const untagged = slices.filter((slice) => slice.key === '');
	const tagged = slices.filter((slice) => slice.key !== '');

	if (tagged.length + untagged.length <= MAX_SLICES)
		return [...tagged, ...untagged];

	const kept = tagged.slice(0, MAX_SLICES);
	const folded = [...tagged.slice(MAX_SLICES), ...untagged];
	return [
		...kept,
		{
			key: 'other',
			label: OTHER_LABEL,
			value: folded.reduce((sum, slice) => sum + slice.value, 0),
		},
	];
}

/* -------------------------------------------------------------------------- */
/* The view in the url                                                         */
/* -------------------------------------------------------------------------- */

export type FinanceView = FinanceFilter & { payment: string | null };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A local calendar date: a statement period is local, never UTC. */
function parseLocalDate(value: string | null) {
	if (!value || !DATE_PATTERN.test(value)) return undefined;
	const [year, month, date] = value.split('-').map(Number);
	const parsed = new Date(year, month - 1, date);
	return parsed.getMonth() === month - 1 ? parsed : undefined;
}

/** The two url bounds as a half-open range, or `undefined` if either is junk. */
function parseRange(
	rawFrom: string | null,
	rawTo: string | null,
): DateRange | undefined {
	const from = parseLocalDate(rawFrom);
	const to = parseLocalDate(rawTo);
	if ((rawFrom && !from) || (rawTo && !to)) return undefined;

	// The url speaks inclusive dates; everything downstream is half-open.
	const toExclusive = to
		? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime()
		: null;
	const start = from?.getTime() ?? null;
	if (start !== null && toExclusive !== null && start >= toExclusive)
		return undefined;
	return { from: start, toExclusive };
}

export function formatLocalDate(at: number) {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The dates in the url are inclusive because that is how a statement reads;
 * everything downstream works half-open, so the end grows by one day here.
 */
export function parseFinanceView(
	params: URLSearchParams,
	/** What to show when the url says nothing: the range last picked here. */
	fallback: DateRange,
): FinanceView {
	/**
	 * Either bound alone is a valid range, so the url is only ignored when it
	 * carries neither. Clearing both therefore cannot be expressed in the url —
	 * the remembered range says it instead, and it is allowed to be open.
	 */
	const range =
		params.has('from') || params.has('to')
			? (parseRange(params.get('from'), params.get('to')) ?? fallback)
			: fallback;

	const tags = [
		...new Set(
			(params.get('tags') ?? '')
				.split(',')
				.map((tag) => tag.trim())
				.filter((tag) => tag !== ''),
		),
	];

	return {
		from: range.from,
		toExclusive: range.toExclusive,
		query: params.get('q')?.trim() ?? '',
		tags,
		subscriptions: params.get('subs') !== '0',
		payment: params.get('payment') || null,
	};
}

type FinanceViewPatch = Partial<{
	range: DateRange | null;
	query: string;
	tags: string[];
	subscriptions: boolean;
	payment: string | null;
	/** Asks the screen to open the create dialog; the palette can only link. */
	create: boolean;
}>;

/** Changes one concern without throwing away the rest of the shareable view. */
export function updateFinanceSearchParams(
	current: URLSearchParams,
	patch: FinanceViewPatch,
) {
	const next = new URLSearchParams(current);

	if ('range' in patch) {
		const from = patch.range?.from ?? null;
		const toExclusive = patch.range?.toExclusive ?? null;
		if (from === null) next.delete('from');
		else next.set('from', formatLocalDate(from));
		// Back to the inclusive form the url speaks.
		if (toExclusive === null) next.delete('to');
		else next.set('to', formatLocalDate(toExclusive - 86_400_000));
	}

	// Defaults are deleted rather than spelled out, so a plain visit keeps a
	// plain url.
	const values: Array<[keyof FinanceViewPatch, string, string | null]> = [
		['query', 'q', patch.query ?? null],
		['tags', 'tags', patch.tags?.join(',') ?? null],
		['subscriptions', 'subs', patch.subscriptions === false ? '0' : null],
		['payment', 'payment', patch.payment ?? null],
		['create', 'new', patch.create ? '1' : null],
	];

	for (const [field, parameter, value] of values) {
		if (!(field in patch)) continue;
		if (value === null || value === '') next.delete(parameter);
		else next.set(parameter, value);
	}

	return next;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const arsFormat = new Intl.NumberFormat('es-AR', {
	style: 'currency',
	currency: 'ARS',
	// Seven-digit peso amounts are unreadable with centavos, and nobody tracks
	// them at that resolution anyway.
	maximumFractionDigits: 0,
});

const usdFormat = new Intl.NumberFormat('es-AR', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

export const formatArs = (value: number) => arsFormat.format(value);
export const formatUsd = (value: number) => usdFormat.format(value);
export const formatMoney = (value: number, currency: 'ars' | 'usd') =>
	currency === 'ars' ? formatArs(value) : formatUsd(value);

const dayFormat = new Intl.DateTimeFormat('es-AR', {
	day: 'numeric',
	month: 'short',
});
const dayYearFormat = new Intl.DateTimeFormat('es-AR', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
});
const monthYearFormat = new Intl.DateTimeFormat('es-AR', {
	month: 'short',
	year: 'numeric',
});

export const formatDay = (at: number) => dayFormat.format(at);
export const formatMonth = (at: number) => monthYearFormat.format(at);

/** The label on the period stepper: the inclusive range, as a statement reads. */
export function formatPeriodLabel(range: DateRange) {
	// The inclusive last day, which is what the label speaks.
	const lastDay =
		range.toExclusive === null ? null : range.toExclusive - 86_400_000;

	if (range.from === null)
		return lastDay === null
			? 'All time'
			: `Until ${dayYearFormat.format(lastDay)}`;
	if (lastDay === null) return `From ${dayYearFormat.format(range.from)}`;

	const from = new Date(range.from);
	const to = new Date(lastDay);
	// The year rides on the end date alone unless the range straddles two, where
	// leaving it off the start would make it ambiguous.
	const start =
		from.getFullYear() === to.getFullYear()
			? dayFormat.format(from)
			: dayYearFormat.format(from);
	return `${start} – ${dayYearFormat.format(to)}`;
}

/**
 * Accepts both `1.234,56` and `1234.56`. The field is a text input rather than
 * `type="number"` because Android shows a keypad whose separator does not match
 * the locale, so whichever one the user reaches for has to work.
 */
export function parseAmount(input: string): number | undefined {
	const trimmed = input.trim().replace(/\s/g, '');
	if (!trimmed) return undefined;

	const lastComma = trimmed.lastIndexOf(',');
	const lastDot = trimmed.lastIndexOf('.');
	const decimal = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : '';

	const normalized = decimal
		? `${trimmed.slice(0, decimal === ',' ? lastComma : lastDot).replace(/[.,]/g, '')}.${trimmed
				.slice((decimal === ',' ? lastComma : lastDot) + 1)
				.replace(/[.,]/g, '')}`
		: trimmed.replace(/[.,]/g, '');

	const value = Number(normalized);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
