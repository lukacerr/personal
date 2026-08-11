// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { FinanceList } from '@web/components/finance/finance-list';
import { filterPayments, type UsdQuote } from '@web/lib/finance';
import type { Payment } from '@web/lib/finance-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const QUOTE: UsdQuote = { compra: 1000, venta: 2000 };
const day = (year: number, month: number, date: number) =>
	new Date(year, month, date).getTime();

const FROM = day(2026, 2, 15);
const TO_EXCLUSIVE = day(2026, 3, 15);

function payment(overrides: Partial<Payment> = {}) {
	return {
		id: 'payment-1',
		title: 'Alquiler',
		tag: null,
		value: 508_075,
		currency: 'ars',
		rateBuy: 1000,
		rateSell: 2000,
		isSubscription: false,
		paidAt: day(2026, 2, 20),
		endedAt: null,
		createdAt: day(2026, 2, 20),
		updatedAt: day(2026, 2, 20),
		...overrides,
	} as Payment;
}

function renderList(
	overrides: Partial<Parameters<typeof FinanceList>[0]> = {},
) {
	const props = {
		payments: [payment()],
		quote: QUOTE,
		from: FROM,
		selectedId: null,
		onEdit: vi.fn(),
		onDuplicate: vi.fn(),
		onCancel: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
	render(<FinanceList {...props} />);
	return props;
}

describe('Finance list', () => {
	/**
	 * The reason subscriptions exist as a window rather than a row per month:
	 * one row shows in every period it covers, and the screen has to explain
	 * why something dated January is on an April statement.
	 */
	it('shows a subscription from outside the period and says where it came from', () => {
		renderList({
			payments: [
				payment({
					id: 'netflix',
					title: 'Netflix',
					isSubscription: true,
					paidAt: day(2025, 0, 10),
				}),
			],
		});

		expect(screen.getAllByText('Netflix').length).toBeGreaterThan(0);
		expect(screen.getAllByText(/^since /).length).toBeGreaterThan(0);
	});

	it('says when a subscription stops applying inside the period', () => {
		renderList({
			payments: [
				payment({
					isSubscription: true,
					paidAt: day(2026, 2, 16),
					endedAt: day(2026, 3, 3),
				}),
			],
		});

		expect(screen.getAllByText(/^ends /).length).toBeGreaterThan(0);
	});

	/**
	 * A converted number nobody could compute would be a lie; the row's own
	 * currency is still the truth, so only the conversion goes missing.
	 */
	it('marks a row no quote can convert instead of printing a number', () => {
		renderList({
			payments: [payment({ rateBuy: null, rateSell: null })],
			quote: undefined,
		});

		expect(screen.getAllByText('no rate').length).toBeGreaterThan(0);
		// The amount in its own currency never goes missing.
		expect(screen.getAllByText(/508\.075/).length).toBeGreaterThan(0);
	});

	it('converts a dollar row into pesos through the selling side', () => {
		renderList({
			payments: [payment({ currency: 'usd', value: 100 })],
		});
		// 100 × venta 2000, never × compra 1000.
		expect(screen.getAllByText(/≈.*200\.000/).length).toBeGreaterThan(0);
	});

	it('invites a first payment rather than showing an empty table', () => {
		renderList({ payments: [] });
		expect(screen.getByText('Nothing in this period')).toBeTruthy();
	});

	/**
	 * The toggle is the only thing standing between "my statement" and "my
	 * statement plus every subscription I have ever had".
	 */
	it('drops subscriptions from the list when they are toggled off', () => {
		const rows = [
			payment({
				id: 'netflix',
				title: 'Netflix',
				isSubscription: true,
				paidAt: day(2025, 0, 10),
			}),
			payment({ id: 'carre', title: 'Carrefour' }),
		];
		const filter = {
			from: FROM,
			toExclusive: TO_EXCLUSIVE,
			query: '',
			tags: [],
		};

		renderList({
			payments: filterPayments(rows, { ...filter, subscriptions: false }),
		});

		expect(screen.queryByText('Netflix')).toBeNull();
		expect(screen.getAllByText('Carrefour').length).toBeGreaterThan(0);
	});
});
