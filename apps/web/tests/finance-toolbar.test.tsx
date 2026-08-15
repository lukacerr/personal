// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinanceToolbar } from '@web/components/finance/finance-toolbar';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const day = (year: number, month: number, date: number) =>
	new Date(year, month, date).getTime();

function renderToolbar(
	overrides: Partial<Parameters<typeof FinanceToolbar>[0]> = {},
) {
	const props = {
		query: '',
		// 15 March through 14 April inclusive.
		range: { from: day(2026, 2, 15), toExclusive: day(2026, 3, 15) },
		selectedTags: [],
		subscriptions: true,
		onQueryChange: vi.fn(),
		onRangeChange: vi.fn(),
		onClearTags: vi.fn(),
		onSubscriptionsChange: vi.fn(),
		onCreate: vi.fn(),
		...overrides,
	};
	render(<FinanceToolbar {...props} />);
	return props;
}

describe('the period popover', () => {
	it('speaks inclusive dates in both inputs', async () => {
		renderToolbar();
		await userEvent.click(screen.getByRole('button', { name: /–/ }));

		expect(screen.getByLabelText('From')).toHaveProperty('value', '2026-03-15');
		expect(screen.getByLabelText('To')).toHaveProperty('value', '2026-04-14');
	});

	/**
	 * An inverted range used to be dropped in silence: the input snapped back
	 * and nothing said why. The pick is still refused, but now it says so
	 * inline — a toast would vanish while the condition stayed true.
	 */
	it('says why an inverted range is not applied instead of dropping it', async () => {
		const props = renderToolbar();
		await userEvent.click(screen.getByRole('button', { name: /–/ }));

		// After the inclusive end, 2026-04-14.
		fireEvent.change(screen.getByLabelText('From'), {
			target: { value: '2026-05-01' },
		});

		expect(props.onRangeChange).not.toHaveBeenCalled();
		expect(screen.getByRole('alert').textContent).toMatch(/end/i);

		// A valid pick applies and clears the message with it.
		fireEvent.change(screen.getByLabelText('From'), {
			target: { value: '2026-03-01' },
		});
		expect(props.onRangeChange).toHaveBeenCalledWith({
			from: day(2026, 2, 1),
			toExclusive: day(2026, 3, 15),
		});
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
