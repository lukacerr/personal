// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	PaymentFormDialog,
	SubscriptionCancelDialog,
} from '@web/components/finance/finance-dialogs';
import type { Payment } from '@web/lib/finance-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const day = (year: number, month: number, date: number) =>
	new Date(year, month, date).getTime();

function payment(overrides: Partial<Payment> = {}) {
	return {
		id: 'payment-1',
		title: 'Alquiler',
		tag: 'Casa',
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

function renderForm(
	overrides: Partial<Parameters<typeof PaymentFormDialog>[0]> = {},
) {
	const props = {
		target: { kind: 'create' } as const,
		tags: ['Casa', 'Comida'],
		busy: false,
		error: undefined,
		onSubmit: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	render(<PaymentFormDialog {...props} />);
	return props;
}

describe('Payment form', () => {
	/**
	 * The same rule has to hold from both entry points. A screen that validates
	 * on create and not on edit is the shape this repo has been bitten by.
	 */
	it.each([
		['creating', { kind: 'create' } as const],
		['editing', { kind: 'edit', payment: payment() } as const],
	])('refuses an empty title when %s', async (_case, target) => {
		const props = renderForm({ target });
		const user = userEvent.setup();

		await user.clear(screen.getByLabelText(/title/i));
		await user.click(screen.getByRole('button', { name: /add payment|save/i }));

		// Inline, where the mistake was made: a toast disappears and this
		// condition is still true.
		expect(screen.getByRole('alert').textContent).toContain('title');
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	it.each([
		['creating', { kind: 'create' } as const],
		['editing', { kind: 'edit', payment: payment() } as const],
	])('refuses a non-positive amount when %s', async (_case, target) => {
		const props = renderForm({ target });
		const user = userEvent.setup();

		await user.type(screen.getByLabelText(/title/i), 'Something');
		await user.clear(screen.getByLabelText(/amount/i));
		await user.type(screen.getByLabelText(/amount/i), '0');
		await user.click(screen.getByRole('button', { name: /add payment|save/i }));

		expect(screen.getByRole('alert').textContent).toContain(
			'greater than zero',
		);
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	/** Android's decimal keypad does not match the es-AR separator. */
	it.each([
		['a local separator', '1.234,56', 1234.56],
		['a plain decimal', '1234.56', 1234.56],
	])('accepts an amount written with %s', async (_case, typed, expected) => {
		const props = renderForm();
		const user = userEvent.setup();

		await user.type(screen.getByLabelText(/title/i), 'Carrefour');
		await user.type(screen.getByLabelText(/amount/i), typed);
		await user.click(screen.getByRole('button', { name: /add payment/i }));

		expect(props.onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ value: expected }),
		);
	});

	it('sends the date the expense happened, not today', async () => {
		const props = renderForm({
			target: { kind: 'edit', payment: payment({ paidAt: day(2026, 0, 5) }) },
		});
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: /save/i }));

		expect(props.onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ paidAt: day(2026, 0, 5) }),
		);
	});

	/**
	 * A duplicate copies what the expense was, not when it happened: the point
	 * is recording the same thing again now.
	 */
	it('seeds a duplicate from the original but dates it today', async () => {
		const original = payment({
			title: 'Carrefour',
			tag: 'Comida',
			value: 25_000,
			paidAt: day(2025, 5, 2),
		});
		const onSubmit = vi.fn();
		renderForm({ target: { kind: 'create', from: original }, onSubmit });
		const user = userEvent.setup();

		expect(screen.getByLabelText(/title/i)).toHaveProperty(
			'value',
			'Carrefour',
		);
		expect(screen.getByLabelText(/^tag$/i)).toHaveProperty('value', 'Comida');

		await user.click(screen.getByRole('button', { name: /add payment/i }));

		const draft = onSubmit.mock.calls[0]?.[0];
		expect(draft).toMatchObject({ title: 'Carrefour', value: 25_000 });
		// Today, not the original's date, and never a copy of a closed window.
		expect(draft.paidAt).not.toBe(day(2025, 5, 2));
		expect(draft.endedAt).toBeNull();
	});

	/**
	 * The cancel dialog already refuses an inverted window; the same rule has
	 * to hold from this entry point too, or editing the start date can produce
	 * the exact window the other door guards against.
	 */
	it('refuses moving the start past the end of a cancelled subscription', async () => {
		const props = renderForm({
			target: {
				kind: 'edit',
				payment: payment({
					isSubscription: true,
					paidAt: day(2026, 0, 5),
					endedAt: day(2026, 1, 5),
				}),
			},
		});
		const user = userEvent.setup();

		await user.clear(screen.getByLabelText(/paid on/i));
		await user.type(screen.getByLabelText(/paid on/i), '2026-03-01');
		await user.click(screen.getByRole('button', { name: /save/i }));

		expect(screen.getByRole('alert').textContent).toContain('after it ended');
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	/**
	 * Unticking "Recurring" drops the end date with it: a window only means
	 * something on a subscription, and a one-off carrying a leftover `endedAt`
	 * would be a shape the screen never shows or edits again.
	 */
	it('drops the end date when recurring is unticked', async () => {
		const props = renderForm({
			target: {
				kind: 'edit',
				payment: payment({
					isSubscription: true,
					paidAt: day(2026, 0, 5),
					endedAt: day(2026, 1, 5),
				}),
			},
		});
		const user = userEvent.setup();

		await user.click(
			screen.getByRole('checkbox', { name: /recurring monthly/i }),
		);
		await user.click(screen.getByRole('button', { name: /save/i }));

		expect(props.onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ isSubscription: false, endedAt: null }),
		);
	});

	/** Editing must not quietly revive a subscription somebody cancelled. */
	it('leaves a closed subscription window closed', async () => {
		const props = renderForm({
			target: {
				kind: 'edit',
				payment: payment({
					isSubscription: true,
					paidAt: day(2026, 0, 5),
					endedAt: day(2026, 1, 5),
				}),
			},
		});
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: /save/i }));

		expect(props.onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ endedAt: day(2026, 1, 5) }),
		);
	});
});

describe('Cancelling a subscription', () => {
	function renderCancel(
		overrides: Partial<Parameters<typeof SubscriptionCancelDialog>[0]> = {},
	) {
		const props = {
			target: payment({ isSubscription: true, paidAt: day(2026, 0, 10) }),
			busy: false,
			error: undefined,
			onConfirm: vi.fn(),
			onClose: vi.fn(),
			...overrides,
		};
		render(<SubscriptionCancelDialog {...props} />);
		return props;
	}

	/**
	 * Cancelling closes the window; it never deletes. Deleting would take the
	 * subscription out of every period that already paid for it.
	 */
	it('reports an end date rather than a deletion', async () => {
		const onConfirm = vi.fn();
		renderCancel({ onConfirm });
		const user = userEvent.setup();

		await user.click(
			screen.getByRole('button', { name: /cancel subscription/i }),
		);

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(typeof onConfirm.mock.calls[0]?.[0]).toBe('number');
	});

	/** A subscription that has not started yet must not default to an invalid date. */
	it('never proposes an end date earlier than the start', async () => {
		const onConfirm = vi.fn();
		renderCancel({
			target: payment({ isSubscription: true, paidAt: day(2099, 0, 1) }),
			onConfirm,
		});
		const user = userEvent.setup();

		expect(screen.queryByRole('alert')).toBeNull();
		await user.click(
			screen.getByRole('button', { name: /cancel subscription/i }),
		);
		expect(onConfirm).toHaveBeenCalledWith(day(2099, 0, 1));
	});

	/**
	 * The API refuses an inverted window, and the client's period predicate
	 * depends on it holding, so the dialog must not be able to ask for one.
	 */
	it('refuses an end date typed before the start', async () => {
		const onConfirm = vi.fn();
		renderCancel({
			target: payment({ isSubscription: true, paidAt: day(2026, 5, 1) }),
			onConfirm,
		});
		const user = userEvent.setup();

		await user.clear(screen.getByLabelText(/last day it applies/i));
		await user.type(
			screen.getByLabelText(/last day it applies/i),
			'2026-01-01',
		);

		expect(screen.getByRole('alert').textContent).toContain(
			'cannot end before it started',
		);
		await user.click(
			screen.getByRole('button', { name: /cancel subscription/i }),
		);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
