import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import { financeSnapshot, useFinanceStore } from '@web/lib/finance-store';
import { ChartNoAxesCombinedIcon } from 'lucide-react';

const FINANCE_PATH = '/finance';

function financePath(params: Record<string, string>) {
	return `${FINANCE_PATH}?${new URLSearchParams(params).toString()}`;
}

export const financeSystem: AppSystem = {
	key: 'finance',
	heading: 'Finance',
	icon: ChartNoAxesCombinedIcon,

	/**
	 * Finance keeps no local database, so nothing the shell watches would ever
	 * tell it the breadcrumb changed. The store reports for itself instead.
	 */
	subscribe: (onChange) => useFinanceStore.subscribe(onChange),

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
				to: financePath({ new: '1' }),
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
