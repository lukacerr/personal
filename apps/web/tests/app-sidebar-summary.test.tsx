// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { AppSidebar } from '@web/components/app-sidebar';
import { SidebarProvider } from '@web/components/ui/sidebar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type { AgentThread } from '@web/lib/agent-api';
import { useAgentStore } from '@web/lib/agent-store';
import { addDays, todayLocalDate, weekdayKanji } from '@web/lib/calendar';
import { calendarDb } from '@web/lib/calendar-db';
import type { Payment } from '@web/lib/finance-api';
import { FINANCE_SETTINGS_KEY } from '@web/lib/finance-settings';
import { useFinanceStore } from '@web/lib/finance-store';
import { notesDb } from '@web/lib/notes-db';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * This happy-dom build exposes no `localStorage` — the same gap agent.test.ts
 * documents — and Finance's summary reads the remembered range from it.
 */
function createMemoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key),
		clear: () => data.clear(),
	};
}

vi.stubGlobal('localStorage', createMemoryStorage());

afterEach(async () => {
	cleanup();
	useFinanceStore.setState({ payments: [], quote: undefined, status: 'idle' });
	useAgentStore.setState({ threads: [], status: 'idle' });
	await calendarDb.events.clear();
	await calendarDb.completions.clear();
	await notesDb.notes.clear();
	await notesDb.outbox.clear();
	localStorage.clear();
});

function renderSidebar(open = true) {
	return render(
		<MemoryRouter>
			<TooltipProvider>
				<SidebarProvider defaultOpen={open}>
					<AppSidebar />
				</SidebarProvider>
			</TooltipProvider>
		</MemoryRouter>,
	);
}

/** The group box a system's summary renders into, found by its own heading. */
const groupOf = (heading: string) =>
	screen.getByRole('group', { name: heading });

const seedFinance = (overrides: Partial<Payment> = {}) => {
	// A range wide enough that "which range" is not what this test is about.
	localStorage.setItem(
		FINANCE_SETTINGS_KEY,
		JSON.stringify({
			version: 2,
			range: { from: null, toExclusive: null },
			budget: { amount: 5000, currency: 'ars' },
		}),
	);
	useFinanceStore.setState({
		payments: [
			{
				id: 'p1',
				title: 'Alquiler',
				tag: null,
				value: 1200,
				currency: 'ars',
				rateBuy: null,
				rateSell: null,
				isSubscription: false,
				paidAt: Date.UTC(2026, 7, 10),
				endedAt: null,
				createdAt: Date.UTC(2026, 7, 10),
				updatedAt: Date.UTC(2026, 7, 10),
				...overrides,
			} as Payment,
		],
		status: 'ready',
	});
};

describe('AppSidebar summaries', () => {
	it('keeps the navigation, whatever the systems have to say', async () => {
		renderSidebar();
		const nav = screen.getByRole('navigation', { name: 'Primary' });
		expect(within(nav).getByText('Calendar')).toBeTruthy();
		expect(within(nav).getByText('Notes')).toBeTruthy();
	});

	/**
	 * The ordinary state of a fresh session: nothing loaded, nothing unsynced.
	 * Four boxes saying so permanently would be worse than no boxes.
	 */
	it('renders no summary group for a system with nothing to report', async () => {
		renderSidebar();
		await waitFor(() =>
			expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy(),
		);
		expect(screen.queryByRole('group', { name: 'Finance' })).toBeNull();
		expect(screen.queryByRole('group', { name: 'Notes' })).toBeNull();
		expect(screen.queryByRole('group', { name: 'Agent' })).toBeNull();
	});

	it('reads the totals out of the store that is already in memory', async () => {
		seedFinance();
		renderSidebar();

		await waitFor(() => expect(groupOf('Finance')).toBeTruthy());
		const finance = groupOf('Finance');
		expect(within(finance).getByText('Pesos')).toBeTruthy();
		expect(within(finance).getByText('Dollars')).toBeTruthy();
		expect(within(finance).getByText('Left over')).toBeTruthy();
		// 5000 budget less 1200 spent, in the budget's own currency.
		expect(within(finance).getByText(/3\.800/)).toBeTruthy();
	});

	/** A reading is not a destination: a total has nowhere to lead. */
	it('leaves a row with no destination out of the link tree', async () => {
		seedFinance();
		renderSidebar();

		await waitFor(() => expect(groupOf('Finance')).toBeTruthy());
		expect(within(groupOf('Finance')).queryAllByRole('link')).toEqual([]);
	});

	it('deep links a conversation and a draft, which do have one', async () => {
		useAgentStore.setState({
			threads: [
				{ id: 't1', title: 'Refactor del shell', updatedAt: 20 } as AgentThread,
				{ id: 't2', title: 'Ideas', updatedAt: 10 } as AgentThread,
			],
			status: 'ready',
		});
		await notesDb.notes.put({
			id: 'n1',
			title: 'Sin guardar',
			path: null,
			isPublic: false,
			viewCount: 0,
			createdAt: 1,
			updatedAt: 1,
			dirty: true,
		});

		renderSidebar();

		await waitFor(() => expect(groupOf('Agent')).toBeTruthy());
		expect(
			within(groupOf('Agent'))
				.getByRole('link', { name: /Refactor del shell/ })
				.getAttribute('href'),
		).toBe('/agent?thread=t1');

		await waitFor(() => expect(groupOf('Notes')).toBeTruthy());
		const draft = groupOf('Notes');
		expect(
			within(draft)
				.getByRole('link', { name: /Sin guardar/ })
				.getAttribute('href'),
		).toBe('/notes?note=n1');
		expect(within(draft).getByText('Draft')).toBeTruthy();
	});

	it('caps conversations at three however many the store holds', async () => {
		useAgentStore.setState({
			threads: Array.from(
				{ length: 8 },
				(_, index) =>
					({
						id: `t${index}`,
						title: `Chat ${index}`,
						updatedAt: 100 - index,
					}) as AgentThread,
			),
			status: 'ready',
		});

		renderSidebar();
		await waitFor(() => expect(groupOf('Agent')).toBeTruthy());
		expect(within(groupOf('Agent')).getAllByRole('link')).toHaveLength(3);
	});

	/**
	 * Agent's group is a recency feed, not a reading: what is next and what is
	 * left matter more at a glance than which chat was touched last, so its rows
	 * sink below Calendar and Finance while its navigation entry stays first.
	 */
	it('reads Agent conversations below Calendar and Finance', async () => {
		seedFinance();
		useAgentStore.setState({
			threads: [{ id: 't1', title: 'Ideas', updatedAt: 10 } as AgentThread],
			status: 'ready',
		});
		await calendarDb.events.put({
			id: 'e1',
			title: 'Dentista',
			details: null,
			tag: null,
			date: todayLocalDate(),
			timeMinutes: 15 * 60,
			recurrence: null,
			completedAt: null,
			createdAt: 1,
			updatedAt: 1,
		});

		renderSidebar();

		await waitFor(() => {
			expect(groupOf('Calendar')).toBeTruthy();
			expect(groupOf('Finance')).toBeTruthy();
			expect(groupOf('Agent')).toBeTruthy();
		});
		const follows = (later: HTMLElement, earlier: HTMLElement) =>
			Boolean(
				earlier.compareDocumentPosition(later) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			);
		expect(follows(groupOf('Finance'), groupOf('Calendar'))).toBe(true);
		expect(follows(groupOf('Agent'), groupOf('Finance'))).toBe(true);
	});

	/**
	 * Calendar's rows are readings for the same reason its breadcrumb is empty:
	 * the url has no way to point at one day, let alone one occurrence.
	 */
	it('reads what is next off the local calendar, without linking a day', async () => {
		const today = todayLocalDate();
		await calendarDb.events.bulkPut([
			{
				id: 'e1',
				title: 'Dentista',
				details: null,
				tag: null,
				date: today,
				timeMinutes: 15 * 60,
				recurrence: null,
				completedAt: null,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: 'e2',
				title: 'Ayer',
				details: null,
				tag: null,
				date: addDays(today, -1),
				timeMinutes: null,
				recurrence: null,
				completedAt: null,
				createdAt: 2,
				updatedAt: 2,
			},
		]);

		renderSidebar();

		await waitFor(() => expect(groupOf('Calendar')).toBeTruthy());
		const calendar = groupOf('Calendar');
		expect(within(calendar).getByText('Dentista')).toBeTruthy();
		expect(
			within(calendar).getByText(`${weekdayKanji(today)} 15:00`),
		).toBeTruthy();
		expect(within(calendar).queryByText('Ayer')).toBeNull();
		expect(within(calendar).queryAllByRole('link')).toEqual([]);
	});

	/**
	 * The cap is the sidebar's, not the agenda's: `upcomingAgenda` would keep
	 * walking forward for a year, so what stops the list is what fits beside the
	 * navigation.
	 */
	it('stops the agenda at five occurrences', async () => {
		const today = todayLocalDate();
		await calendarDb.events.bulkPut(
			['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis'].map((title, index) => ({
				id: `e${index}`,
				title,
				details: null,
				tag: null,
				date: today,
				timeMinutes: (8 + index) * 60,
				recurrence: null,
				completedAt: null,
				createdAt: index,
				updatedAt: index,
			})),
		);

		renderSidebar();

		await waitFor(() => expect(groupOf('Calendar')).toBeTruthy());
		const calendar = groupOf('Calendar');
		expect(within(calendar).getByText('Cinco')).toBeTruthy();
		expect(within(calendar).queryByText('Seis')).toBeNull();
	});

	/**
	 * The routine tags fill most days, so with them in, a daily habit would take
	 * every slot every day and the summary would never say anything a glance did
	 * not already know.
	 */
	it('skips the routine tags and shows what is actually coming', async () => {
		const today = todayLocalDate();
		const event = (
			id: string,
			title: string,
			tag: string | null,
			minutes: number,
		) => ({
			id,
			title,
			details: null,
			tag,
			date: today,
			timeMinutes: minutes,
			recurrence: null,
			completedAt: null,
			createdAt: minutes,
			updatedAt: minutes,
		});
		await calendarDb.events.bulkPut([
			event('e1', 'PIN x3', '回', 8 * 60),
			event('e2', 'オフィス', 'タップ', 9 * 60),
			event('e3', 'Bloodwork', null, 10 * 60),
		]);

		renderSidebar();

		await waitFor(() => expect(groupOf('Calendar')).toBeTruthy());
		const calendar = groupOf('Calendar');
		expect(within(calendar).getByText('Bloodwork')).toBeTruthy();
		expect(within(calendar).queryByText('PIN x3')).toBeNull();
		expect(within(calendar).queryByText('オフィス')).toBeNull();
	});

	/**
	 * A collapsed sidebar stays in the DOM, so without a gate it would keep
	 * every system answering questions nobody can see the answers to.
	 */
	it('asks the systems nothing while it is collapsed', async () => {
		seedFinance();
		renderSidebar(false);

		await waitFor(() =>
			expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy(),
		);
		expect(screen.queryByRole('group', { name: 'Finance' })).toBeNull();
	});
});
