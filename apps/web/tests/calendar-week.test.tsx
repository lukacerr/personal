// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarWeek } from '@web/components/calendar/calendar-week';
import type { CalendarDayGroup, CalendarEvent } from '@web/lib/calendar';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

let counter = 0;

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	counter += 1;
	return {
		id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
		title: `Event ${counter}`,
		details: null,
		tag: null,
		date: null,
		timeMinutes: null,
		recurrence: null,
		completedAt: null,
		createdAt: counter,
		updatedAt: counter,
		...overrides,
	};
}

type WeekProps = Parameters<typeof CalendarWeek>[0];

function renderWeek(
	events: CalendarEvent[],
	overrides: Partial<WeekProps> = {},
) {
	const onToggle = vi.fn();
	const onToggleDetail = vi.fn();
	const onCommitEdit = vi.fn();
	const props: WeekProps = {
		window: { start: '2026-08-18', end: '2026-08-23' },
		today: '2026-08-18',
		events,
		completions: [],
		groups: [],
		showDone: false,
		selectedKey: null,
		editingKey: null,
		onDropOnDay: vi.fn(),
		onToggle,
		onToggleDetail,
		onSelect: vi.fn(),
		onEdit: vi.fn(),
		onClone: vi.fn(),
		onDelete: vi.fn(),
		onCommitEdit,
		onCancelEdit: vi.fn(),
		...overrides,
	};
	const view = render(<CalendarWeek {...props} />);
	return {
		onToggle,
		onToggleDetail,
		onCommitEdit,
		rerender: (next: Partial<WeekProps>) =>
			view.rerender(<CalendarWeek {...props} {...next} />),
	};
}

describe('CalendarWeek', () => {
	it('renders only the days that hold something', () => {
		renderWeek([
			makeEvent({ title: 'Rosita', date: '2026-08-18', timeMinutes: 480 }),
			makeEvent({ title: 'Vet', date: '2026-08-22' }),
		]);

		expect(screen.getByRole('heading', { name: '火 08/18' })).toBeTruthy();
		expect(screen.getByRole('heading', { name: '土 08/22' })).toBeTruthy();
		// Wednesday holds nothing, so it does not spend a heading saying so.
		expect(screen.queryByRole('heading', { name: '水 08/19' })).toBeNull();
	});

	it('says so once when nothing at all is on these days', () => {
		renderWeek([]);
		expect(screen.getByText('Nothing in these days.')).toBeTruthy();
	});

	it('reads a custom group as one bucket with date chips per row', () => {
		const group: CalendarDayGroup = {
			from: '2026-08-22',
			to: '2026-08-24',
			label: '週末',
		};
		renderWeek(
			[
				makeEvent({ title: 'Vet', date: '2026-08-22' }),
				makeEvent({ title: 'Asado', date: '2026-08-23' }),
			],
			{ groups: [group] },
		);

		expect(screen.getByRole('heading', { name: '週末 08/22–23' })).toBeTruthy();
		expect(screen.queryByRole('heading', { name: '土 08/22' })).toBeNull();
		expect(screen.getByRole('checkbox', { name: 'Vet · 08/22' })).toBeTruthy();
		expect(
			screen.getByRole('checkbox', { name: 'Asado · 08/23' }),
		).toBeTruthy();
	});

	it('hides a fully done day along with its rows, until asked', () => {
		const done = makeEvent({
			title: 'Hecho',
			date: '2026-08-18',
			completedAt: 5,
		});
		const { rerender } = renderWeek([done]);

		expect(screen.queryByText('Hecho')).toBeNull();
		expect(screen.queryByRole('heading', { name: '火 08/18' })).toBeNull();

		rerender({ showDone: true });
		expect(screen.getByText('Hecho')).toBeTruthy();
		expect(screen.getByText('1/1')).toBeTruthy();
	});

	it('checks a recurring occurrence for its own day, not the series', async () => {
		const daily = makeEvent({
			title: '毎日',
			date: '2026-08-01',
			timeMinutes: 570,
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		const { onToggle } = renderWeek([daily]);

		await userEvent.click(
			screen.getByRole('checkbox', { name: '毎日 · 08/19' }),
		);

		expect(onToggle).toHaveBeenCalledWith(
			expect.objectContaining({ date: '2026-08-19', recurring: true }),
		);
	});

	it('opens the selected row as its own text and commits on Enter', async () => {
		const event = makeEvent({
			title: 'Rosita',
			date: '2026-08-18',
			timeMinutes: 480,
			tag: 'salud',
		});
		const { onCommitEdit } = renderWeek([event], {
			editingKey: `${event.id}:2026-08-18`,
		});

		const editor = screen.getByRole('textbox', { name: 'Edit Rosita' });
		expect((editor as HTMLTextAreaElement).value).toBe(
			'08/18 08:00 Rosita [salud]',
		);

		await userEvent.clear(editor);
		await userEvent.type(editor, '08/19 09:30 Rosita vet{Enter}');

		expect(onCommitEdit).toHaveBeenCalledWith(
			event,
			expect.objectContaining({
				title: 'Rosita vet',
				date: '2026-08-19',
				timeMinutes: 570,
			}),
		);
	});

	it('renders detail lines as sub-checks that toggle by line', async () => {
		const event = makeEvent({
			title: 'Pagar todo',
			date: '2026-08-18',
			details: 'Mono, CCs\n[x] Nuevo CBU',
		});
		const { onToggleDetail } = renderWeek([event]);

		expect(
			screen
				.getByRole('checkbox', { name: 'Nuevo CBU' })
				.getAttribute('aria-checked'),
		).toBe('true');

		await userEvent.click(screen.getByRole('checkbox', { name: 'Mono, CCs' }));
		expect(onToggleDetail).toHaveBeenCalledWith(
			expect.objectContaining({ event }),
			0,
		);
	});
});
