// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarQuickAdd } from '@web/components/calendar/calendar-quick-add';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

describe('CalendarQuickAdd', () => {
	it('parses the full note notation and stays ready for the next line', async () => {
		const onAdd = vi.fn();
		render(
			<CalendarQuickAdd today="2026-08-14" onAdd={onAdd} onTabOut={() => {}} />,
		);

		const input = screen.getByRole('textbox', { name: 'Quick add' });
		await userEvent.type(input, '08/16 12:00 Regalo{Enter}');

		expect(onAdd).toHaveBeenCalledWith({
			title: 'Regalo',
			done: false,
			date: '2026-08-16',
			timeMinutes: 720,
			tag: null,
			recurrence: null,
			details: null,
		});
		expect((input as HTMLInputElement).value).toBe('');
	});

	it('sends a bare line to today, untimed', async () => {
		const onAdd = vi.fn();
		render(
			<CalendarQuickAdd today="2026-08-14" onAdd={onAdd} onTabOut={() => {}} />,
		);

		await userEvent.type(
			screen.getByRole('textbox', { name: 'Quick add' }),
			'Lavaseca{Enter}',
		);

		expect(onAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Lavaseca',
				date: '2026-08-14',
				timeMinutes: null,
			}),
		);
	});
});
