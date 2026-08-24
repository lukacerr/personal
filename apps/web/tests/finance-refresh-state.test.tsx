// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import Finance from '@web/routes/_app.finance';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
	payments: [{ id: 'cached-payment', title: 'Cached payment' }] as {
		id: string;
		title: string;
	}[],
	status: 'failed' as 'failed' | 'offline',
	error: 'Your payments could not reach the server.',
	quote: undefined,
	quoteFailed: false,
	load: vi.fn(async () => undefined),
	loadQuote: vi.fn(async () => undefined),
	record: vi.fn(async () => undefined),
	revise: vi.fn(async () => undefined),
	discard: vi.fn(async () => undefined),
}));

vi.mock('@web/lib/finance-store', () => ({ useFinanceStore: () => store }));
vi.mock('@web/lib/shared-settings', () => ({
	useSharedSettings: () => ({ settings: {}, patchSettings: vi.fn() }),
}));
vi.mock('@web/lib/create-param', () => ({ useConsumeCreateParam: vi.fn() }));
vi.mock('@web/components/finance/finance-toolbar', () => ({
	FinanceToolbar: () => <div>Finance toolbar</div>,
}));
vi.mock('@web/components/finance/finance-summary', () => ({
	FinanceSummary: () => <div>Finance summary</div>,
}));
vi.mock('@web/components/finance/finance-breakdown', () => ({
	FinanceBreakdown: () => <div>Finance breakdown</div>,
}));
vi.mock('@web/components/finance/finance-list', () => ({
	FinanceList: () => <div>Cached payments</div>,
}));
vi.mock('@web/components/finance/finance-dialogs', () => ({
	BudgetDialog: () => null,
	PaymentDeleteDialog: () => null,
	PaymentFormDialog: () => null,
	SubscriptionCancelDialog: () => null,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	store.payments = [{ id: 'cached-payment', title: 'Cached payment' }];
	store.status = 'failed';
});

describe('Finance background refresh failure', () => {
	it('keeps cached content visible and exposes the refresh failure', () => {
		render(
			<MemoryRouter>
				<Finance />
			</MemoryRouter>,
		);

		expect(screen.getByText('Finance summary')).toBeTruthy();
		expect(screen.getByText('Cached payments')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain(
			'Your payments could not reach the server.',
		);
	});

	/**
	 * A store that could not reach the server and one that never left the device
	 * are the same thing to a reader looking at an empty screen: both need the
	 * reason and a retry, not a spinner that never resolves.
	 */
	it.each(['failed', 'offline'] as const)(
		'explains an empty ledger when the read ended %s',
		(status) => {
			store.payments = [];
			store.status = status;

			render(
				<MemoryRouter>
					<Finance />
				</MemoryRouter>,
			);

			expect(
				screen.getByText('Your payments could not reach the server.'),
			).toBeTruthy();
			expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
			// The centred panel, not an alert stacked above an empty table.
			expect(screen.queryByText('Cached payments')).toBeNull();
		},
	);
});
