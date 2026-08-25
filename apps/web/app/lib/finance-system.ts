import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import {
	type AppSystem,
	matchesCommandQuery,
	refreshIndexStore,
	type SystemSummaryRow,
	systemPath,
} from '@web/lib/app-systems';
import {
	currentMonthRange,
	filterPayments,
	financeTotals,
	formatArs,
	formatMoney,
	remainingFor,
} from '@web/lib/finance';
import type { Payment } from '@web/lib/finance-api';
import {
	type FinanceSettings,
	loadFinanceSettings,
} from '@web/lib/finance-settings';
import {
	financeSnapshot,
	type LiveQuote,
	useFinanceStore,
} from '@web/lib/finance-store';
import { ChartNoAxesCombinedIcon } from 'lucide-react';

const FINANCE_PATH = '/finance';

/**
 * The four numbers, over the range this browser last picked.
 *
 * The remembered range rather than the url's: the sidebar renders beside every
 * screen, and most of them carry no range at all. It reads the local mirror
 * instead of the shared copy for the same reason nothing here fetches — this is
 * a reading of what the device already knows.
 *
 * Left over lands in the budget's own currency, where the subtraction needs no
 * quote and can never come back `null`. Pricing it through the spread would
 * make the one number a person actually checks depend on a third party being up.
 */
export function financeSummaryRows(
	payments: Payment[],
	quote: LiveQuote | undefined,
	settings: FinanceSettings,
	now: number,
): SystemSummaryRow[] {
	// Silence, not zeroes: with no ledger and no quote the store never loaded,
	// and "$ 0" would be a claim about a period rather than the absence of one.
	if (payments.length === 0 && !quote) return [];

	const range = settings.range ?? currentMonthRange(now);
	const totals = financeTotals(
		filterPayments(payments, {
			...range,
			query: '',
			tags: [],
			subscriptions: true,
		}),
		quote,
	);

	const rows: SystemSummaryRow[] = [
		{ key: 'ars', label: 'Pesos', detail: formatMoney(totals.ars, 'ars') },
		{ key: 'usd', label: 'Dollars', detail: formatMoney(totals.usd, 'usd') },
	];

	const budget = settings.budget;
	const left = budget && remainingFor(budget, totals, quote)?.[budget.currency];
	if (budget && left !== null && left !== undefined)
		rows.push({
			key: 'remaining',
			label: 'Left over',
			detail: formatMoney(left, budget.currency),
		});

	if (quote)
		rows.push({
			key: 'rate',
			label: 'USD',
			detail: `${formatArs(quote.compra)} / ${formatArs(quote.venta)}`,
		});

	return rows;
}

export const financeSystem: AppSystem = {
	key: 'finance',
	heading: 'Finance',
	icon: ChartNoAxesCombinedIcon,
	clearLocalData: () => useFinanceStore.getState().reset(),

	/**
	 * Finance keeps no local database, so nothing the shell watches would ever
	 * tell it the breadcrumb changed. The store reports for itself instead —
	 * only when the rows themselves move: the shell re-runs every system's
	 * loaders on each report, and a status flip changes nothing it can show.
	 */
	subscribe: (onChange) =>
		useFinanceStore.subscribe((state, previous) => {
			if (state.payments !== previous.payments) onChange();
		}),

	/**
	 * The ledger and the quote, in one pass.
	 *
	 * The quote rides along here — and nowhere else automatic — because the
	 * sidebar shows it from every screen and has no refresh control of its own:
	 * loading it only on `/finance` would mean a rate from whenever that screen
	 * was last open. It stays off the *critical path* all the same, which is what
	 * `loadQuote` being its own call has always been about; the API caches the
	 * quote in Redis with its own freshness window, so this never stampedes
	 * dolarapi however often it is asked.
	 *
	 * Only the ledger decides the verdict. A quote that could not be had must not
	 * put the index into backoff because a third party is down — the store
	 * reports that itself through `quoteFailed`, and `loadQuote` never rejects.
	 */
	async refresh(_search, isCurrent) {
		const [indexed] = await Promise.all([
			refreshIndexStore(useFinanceStore)('', isCurrent),
			useFinanceStore.getState().loadQuote(true, isCurrent),
		]);
		return indexed;
	},

	/**
	 * The sidebar reads these totals from every screen, so the pull follows them
	 * there. Still no timer anywhere: the coordinator fires on a sign of life and
	 * only when this system has aged out, so an app sitting open with nobody in
	 * the room asks for nothing and the container stays asleep.
	 */
	refreshEverywhere: true,

	/**
	 * Reads the copy in memory and asks for nothing itself — whatever the last
	 * pull left there. Keeping this a pure read is what lets the shell resolve
	 * every system's summary on each Dexie revision without any of them
	 * deciding, from inside a render, to hit the network.
	 */
	async loadSummary() {
		const { payments, quote } = financeSnapshot();
		return {
			rows: financeSummaryRows(
				payments,
				quote,
				loadFinanceSettings(window.localStorage),
				Date.now(),
			),
		};
	},

	/**
	 * Only the action, deliberately: individual payments are not things you go
	 * *to*. They are read as a period, and the screen's own search already
	 * filters them by title and tag in the context of their totals, which a flat
	 * palette row cannot give.
	 *
	 * The palette navigates and does not run callbacks, so the action is a link
	 * to a url the screen consumes and then clears. That also makes it a deep
	 * link worth having on its own.
	 */
	async searchCommands(query, limit) {
		if (limit < 1) return [];
		if (!matchesCommandQuery(query, 'Add payment', 'new expense gasto'))
			return [];
		return [
			{
				id: 'create',
				label: 'Add payment',
				detail: 'Finance',
				to: systemPath(FINANCE_PATH, { new: '1' }),
			},
		];
	},

	async loadBreadcrumbTrail(pathname, search): Promise<AppBreadcrumbItem[]> {
		if (pathname !== FINANCE_PATH) return [];
		const selected = new URLSearchParams(search).get('payment');
		if (!selected) return [];

		const title = financeSnapshot().payments.find(
			(payment) => payment.id === selected,
		)?.title;
		return title
			? [{ key: 'payment', label: title, icon: ChartNoAxesCombinedIcon }]
			: [];
	},
};
