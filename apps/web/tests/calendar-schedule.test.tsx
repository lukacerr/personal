// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { CalendarSchedule } from '@web/components/calendar/calendar-schedule';
import type { CalendarEvent } from '@web/lib/calendar';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		title: 'Exam',
		details: null,
		tag: null,
		date: null,
		timeMinutes: null,
		recurrence: null,
		completedAt: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function renderSchedule(events: CalendarEvent[]) {
	render(
		<CalendarSchedule
			events={events}
			completions={[]}
			window={{ start: '2026-08-18', end: '2026-08-23' }}
			today="2026-08-18"
			showDone={false}
			selectedKey={null}
			editingKey={null}
			onToggle={vi.fn()}
			onToggleDetail={vi.fn()}
			onSelect={vi.fn()}
			onEdit={vi.fn()}
			onClone={vi.fn()}
			onDelete={vi.fn()}
			onCommitEdit={vi.fn()}
			onCancelEdit={vi.fn()}
		/>,
	);
}

describe('CalendarSchedule', () => {
	/**
	 * Every row on the screen keeps its actions in the menu; the Schedule's
	 * narrow column was merely the first place that needed it.
	 */
	it('keeps the row actions in the menu at every width', () => {
		renderSchedule([makeEvent({ date: '2026-09-01' })]);

		expect(screen.queryByRole('button', { name: 'Edit: Exam' })).toBeNull();

		const menu = screen.getByRole('button', { name: 'Actions for Exam' });
		expect(menu.className ?? '').not.toContain('sm:hidden');
	});
});
