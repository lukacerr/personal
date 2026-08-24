// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { refreshCalendar } from '@web/lib/calendar-sync';
import { refreshNotes } from '@web/lib/notes-sync';
import {
	SYSTEM_REFRESH_STALE_MS,
	useSystemRefresh,
} from '@web/lib/system-refresh';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/notes-sync', () => ({
	refreshNotes: vi.fn(async () => ({ status: 'refreshed' as const })),
}));
vi.mock('@web/lib/calendar-sync', () => ({
	refreshCalendar: vi.fn(async () => ({
		status: 'refreshed' as const,
		discarded: [],
	})),
	describeDiscardedSync: () => 'discarded',
}));

const agentLoad = vi.fn(async () => 'loaded' as const);
vi.mock('@web/lib/agent-store', () => ({
	useAgentStore: { getState: () => ({ load: agentLoad }) },
	agentSnapshot: () => ({ threads: [], status: 'ready' }),
}));

const financeLoad = vi.fn(async () => 'loaded' as const);
vi.mock('@web/lib/finance-store', () => ({
	useFinanceStore: { getState: () => ({ load: financeLoad }) },
	financeSnapshot: () => ({ payments: [], status: 'ready' }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const notesPull = vi.mocked(refreshNotes);
const calendarPull = vi.mocked(refreshCalendar);
const start = 1_700_000_000_000;

function Shell({
	pathname,
	search = '',
}: {
	pathname: string;
	search?: string;
}) {
	useSystemRefresh(pathname, search, true);
	return null;
}

beforeEach(() => {
	// Only the clock: the coordinator runs on no timer, and Testing Library
	// still needs real ones.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(start);
	for (const spy of [notesPull, calendarPull, agentLoad, financeLoad])
		spy.mockClear();
	vi.mocked(toast.error).mockClear();
});

afterEach(() => {
	// No `globals`, so Testing Library's auto cleanup never registers: a mount
	// left behind keeps its listeners and answers the next test's events.
	cleanup();
	vi.useRealTimers();
});

/**
 * Some systems cannot wait for someone to navigate to their screen: the command
 * palette reads the Notes and Agent indexes from anywhere, and Calendar's outbox
 * has to ship whenever a connection comes back. They declare
 * `refreshEverywhere`, and the shell's one coordinator services them next to
 * whatever the route resolves to — which is what replaced a hand-rolled
 * bootstrap component per system.
 */
describe('Refreshing a system from another screen', () => {
	it('pulls an app-wide index at startup, wherever the app opened', () => {
		render(<Shell pathname="/finance" />);

		expect(notesPull).toHaveBeenCalledOnce();
		// No note id: the open note belongs to the route's own refresh.
		expect(notesPull).toHaveBeenCalledWith(undefined, expect.any(Function));
		expect(agentLoad).toHaveBeenCalledOnce();
		expect(financeLoad).toHaveBeenCalledOnce();
	});

	it('pulls again when someone comes back to a window left open elsewhere', () => {
		render(<Shell pathname="/finance" />);
		vi.setSystemTime(start + SYSTEM_REFRESH_STALE_MS);

		window.dispatchEvent(new Event('focus'));

		expect(notesPull).toHaveBeenCalledTimes(2);
	});

	it('keeps quiet while the indexes it already has are fresh', () => {
		render(<Shell pathname="/finance" />);

		for (let move = 0; move < 50; move += 1)
			document.dispatchEvent(new Event('pointermove'));

		expect(notesPull).toHaveBeenCalledOnce();
		expect(calendarPull).toHaveBeenCalledOnce();
	});

	it('says nothing when a background pull fails', async () => {
		notesPull.mockResolvedValue({
			status: 'failed',
			error: new Error('boom'),
		});

		render(<Shell pathname="/finance" />);
		await vi.waitFor(() => expect(notesPull).toHaveBeenCalledOnce());

		expect(toast.error).not.toHaveBeenCalled();
	});

	it('stops pulling once the shell unmounts', () => {
		const view = render(<Shell pathname="/finance" />);
		view.unmount();
		vi.setSystemTime(start + SYSTEM_REFRESH_STALE_MS);

		window.dispatchEvent(new Event('focus'));

		expect(notesPull).toHaveBeenCalledOnce();
	});

	/**
	 * On its own screen a system is one target, not two: the route's entry wins
	 * because it carries the search string the off-route entry cannot know.
	 */
	it('pulls a system once on its own screen, with the route search', () => {
		render(<Shell pathname="/notes" search="?note=abc" />);

		expect(notesPull).toHaveBeenCalledOnce();
		expect(notesPull).toHaveBeenCalledWith('abc', expect.any(Function));
	});

	/**
	 * The reconnect bypass skips the age gate, so it is the one path where two
	 * entries for the same system would both fire — once with the route's note
	 * and once without it, two requests for one system.
	 */
	it('pulls its own screen system once when a reconnect unblocks', () => {
		const online = vi.spyOn(navigator, 'onLine', 'get');
		render(<Shell pathname="/notes" search="?note=abc" />);
		notesPull.mockClear();

		online.mockReturnValue(false);
		document.dispatchEvent(new Event('pointermove'));
		online.mockReturnValue(true);
		window.dispatchEvent(new Event('online'));

		expect(notesPull).toHaveBeenCalledOnce();
		expect(notesPull).toHaveBeenCalledWith('abc', expect.any(Function));
		online.mockRestore();
	});
});
