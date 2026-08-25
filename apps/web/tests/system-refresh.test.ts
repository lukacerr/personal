// @vitest-environment happy-dom
import { activeSystem, refreshIndexStore } from '@web/lib/app-systems';
import type { IndexLoadOutcome } from '@web/lib/index-store';
import {
	createRefreshCoordinator,
	SYSTEM_REFRESH_RETRY_BASE_MS,
	SYSTEM_REFRESH_RETRY_MAX_MS,
	SYSTEM_REFRESH_STALE_MS,
} from '@web/lib/system-refresh';
import { describe, expect, it, vi } from 'vitest';

function setup(
	overrides: Partial<Parameters<typeof createRefreshCoordinator>[0]> = {},
) {
	let clock = 1_700_000_000_000;
	const refresh = vi.fn(async () => true);
	const current: {
		target: { key: string; refresh: () => Promise<boolean> } | undefined;
	} = { target: { key: 'notes', refresh } };

	const coordinator = createRefreshCoordinator({
		getTargets: () => (current.target ? [current.target] : []),
		now: () => clock,
		isOnline: () => true,
		...overrides,
	});

	return {
		coordinator,
		refresh,
		current,
		/** Time passes without anything running: nothing here is on a timer. */
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const STALE = SYSTEM_REFRESH_STALE_MS;

/**
 * The problem this solves: an app left open and focused on one machine never
 * learns about edits made from another. There is no poll — a request only
 * happens when someone is actually there — so the triggers are signs of life,
 * gated on how old the data on screen already is.
 */
describe('System refresh coordinator', () => {
	it('pulls the first time it sees a system', () => {
		const { coordinator, refresh } = setup();

		coordinator.signal();

		expect(refresh).toHaveBeenCalledOnce();
	});

	it('ignores activity until the data has aged out', () => {
		const { coordinator, refresh, advance } = setup();
		coordinator.signal();

		advance(STALE - 1);
		coordinator.signal();
		expect(refresh).toHaveBeenCalledOnce();

		advance(1);
		coordinator.signal();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('collapses a burst of activity into one pull', () => {
		const { coordinator, refresh, advance } = setup();
		coordinator.signal();
		advance(STALE);

		for (let move = 0; move < 50; move += 1) coordinator.signal();

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	/**
	 * Finance, Storage and Credentials all skip their own load once the store is
	 * `ready`, so returning to one of those screens is the only moment its
	 * staleness gets judged at all.
	 */
	it('ages each system on its own clock', () => {
		const { coordinator, refresh, current, advance } = setup();
		const finance = vi.fn(async () => true);

		coordinator.signal();
		advance(STALE - 1);

		current.target = { key: 'finance', refresh: finance };
		coordinator.signal();
		expect(finance).toHaveBeenCalledOnce();

		advance(1);
		current.target = { key: 'notes', refresh };
		coordinator.signal();

		// Notes has now aged out; Finance, pulled a moment ago, has not.
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(finance).toHaveBeenCalledOnce();
	});

	it('stays quiet while offline', () => {
		const { coordinator, refresh } = setup({ isOnline: () => false });

		coordinator.signal();

		expect(refresh).not.toHaveBeenCalled();
	});

	it('does nothing for a screen no system claims', () => {
		const { coordinator, refresh, current } = setup();
		current.target = undefined;

		coordinator.signal();

		expect(refresh).not.toHaveBeenCalled();
	});

	it('backs off a failed pull instead of retrying on every pointer move', async () => {
		const refresh = vi.fn(async () => false);
		const { coordinator, advance } = setup({
			getTargets: () => [{ key: 'notes', refresh }],
		});

		coordinator.signal();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

		for (let move = 0; move < 50; move += 1) coordinator.signal();
		expect(refresh).toHaveBeenCalledOnce();

		advance(SYSTEM_REFRESH_RETRY_BASE_MS);
		coordinator.signal();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('caps repeated failure backoff below the normal stale interval', async () => {
		const refresh = vi.fn(async (): Promise<boolean> => {
			throw new Error('boom');
		});
		const { coordinator, advance } = setup({
			getTargets: () => [{ key: 'notes', refresh }],
		});

		for (let failure = 0; failure < 6; failure += 1) {
			coordinator.signal();
			await vi.waitFor(() =>
				expect(refresh).toHaveBeenCalledTimes(failure + 1),
			);
			advance(SYSTEM_REFRESH_RETRY_MAX_MS);
		}

		coordinator.signal();
		expect(refresh).toHaveBeenCalledTimes(7);
		expect(SYSTEM_REFRESH_RETRY_MAX_MS).toBeLessThan(STALE);
	});
});

/**
 * Reconnecting is not one more sign of life. Every other signal says what is on
 * screen *might* be old; a connection coming back says work that could not
 * leave this device now can. The pull is what drains a system's outbox, so
 * waiting out the stale window keeps local edits invisible to every other
 * device for as long as three minutes — or until the next visit, if the screen
 * changes first.
 */
describe('Coming back from offline', () => {
	const offlineSetup = () => {
		const online = { value: true };
		return { online, ...setup({ isOnline: () => online.value }) };
	};

	it('drains work queued while offline instead of waiting out the stale window', () => {
		const { coordinator, refresh, advance, online } = offlineSetup();
		coordinator.signal();
		advance(20_000);

		// The connection drops and the user keeps editing: those edits queue.
		online.value = false;
		coordinator.signal();
		expect(refresh).toHaveBeenCalledOnce();
		advance(20_000);

		online.value = true;
		coordinator.signal('reconnect');

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('ignores a reconnect that interrupted nothing', () => {
		const { coordinator, refresh, advance } = offlineSetup();
		coordinator.signal();
		advance(1_000);

		coordinator.signal('reconnect');

		expect(refresh).toHaveBeenCalledOnce();
	});

	it('spends the bypass once, so flapping connectivity is not a request per flap', () => {
		const { coordinator, refresh, online } = offlineSetup();
		coordinator.signal();
		online.value = false;
		coordinator.signal();
		online.value = true;

		coordinator.signal('reconnect');
		coordinator.signal('reconnect');

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('still waits out the backoff of a failed pull', async () => {
		const refresh = vi.fn(async () => false);
		const online = { value: true };
		const { coordinator, advance } = setup({
			getTargets: () => [{ key: 'notes', refresh }],
			isOnline: () => online.value,
		});
		coordinator.signal();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

		online.value = false;
		coordinator.signal();
		online.value = true;
		coordinator.signal('reconnect');
		expect(refresh).toHaveBeenCalledOnce();

		advance(SYSTEM_REFRESH_RETRY_BASE_MS);
		coordinator.signal('reconnect');
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('reads the online event as a reconnect', () => {
		const { coordinator, refresh, advance, online } = offlineSetup();
		const stop = coordinator.listen();
		coordinator.signal();
		advance(20_000);
		online.value = false;
		document.dispatchEvent(new Event('pointermove'));
		online.value = true;

		window.dispatchEvent(new Event('online'));

		expect(refresh).toHaveBeenCalledTimes(2);
		stop();
	});
});

describe('Zustand index refresh', () => {
	it('forwards the session guard to the store load', async () => {
		const load = vi.fn(async (): Promise<IndexLoadOutcome> => 'loaded');
		const guard = () => true;
		const store = { getState: () => ({ load }) };

		await refreshIndexStore(store)('', guard);

		expect(load).toHaveBeenCalledWith(true, guard);
	});

	it('does not credit an index load invalidated before it completes', async () => {
		let current = true;
		const load = vi.fn(async (): Promise<IndexLoadOutcome> => {
			current = false;
			return 'loaded';
		});
		const store = { getState: () => ({ load }) };

		expect(await refreshIndexStore(store)('', () => current)).toBe(false);
	});

	/**
	 * The verdict has to come from the call, not from the store's shared
	 * `status`: an interleaved search or a second caller flipping it between the
	 * await and the read used to decide this pull's outcome.
	 */
	it.each([
		['loaded', true],
		['unchanged', true],
		['failed', false],
		['offline', false],
		['skipped', false],
	] as const)('reports %s as fresh=%s', async (outcome, fresh) => {
		const store = {
			getState: () => ({
				load: async (): Promise<IndexLoadOutcome> => outcome,
			}),
		};

		expect(await refreshIndexStore(store)('', () => true)).toBe(fresh);
	});
});

/**
 * `visibilitychange` and `focus` miss the case this feature exists for: the
 * window stayed visible and focused the whole time nobody was in the room.
 * There, an input event is the only evidence anyone came back.
 */
describe('What counts as coming back', () => {
	it.each([
		['pointermove', () => document.dispatchEvent(new Event('pointermove'))],
		['pointerdown', () => document.dispatchEvent(new Event('pointerdown'))],
		['keydown', () => document.dispatchEvent(new Event('keydown'))],
		['wheel', () => document.dispatchEvent(new Event('wheel'))],
		['touchstart', () => document.dispatchEvent(new Event('touchstart'))],
		['window focus', () => window.dispatchEvent(new Event('focus'))],
		['reconnecting', () => window.dispatchEvent(new Event('online'))],
		[
			'the tab becoming visible',
			() => document.dispatchEvent(new Event('visibilitychange')),
		],
	])('pulls on %s after time away', (_signal, fire) => {
		const { coordinator, refresh, advance } = setup();
		const stop = coordinator.listen();
		coordinator.signal();
		advance(STALE);

		fire();

		expect(refresh).toHaveBeenCalledTimes(2);
		stop();
	});

	/**
	 * The invariant the whole design exists for: an app left open with nobody in
	 * the room emits nothing, so the serverless container gets to stay asleep.
	 * Time passing is not a sign of life. This is the test that fails the day
	 * someone reaches for a `setInterval`.
	 */
	it('never pulls on time alone, however long nobody touches it', () => {
		const { coordinator, refresh, advance } = setup();
		const stop = coordinator.listen();
		coordinator.signal();
		expect(refresh).toHaveBeenCalledOnce();

		for (let hour = 0; hour < 8; hour += 1) advance(60 * 60 * 1000);

		expect(refresh).toHaveBeenCalledOnce();
		stop();
	});

	it('goes quiet once detached', () => {
		const { coordinator, refresh, advance } = setup();
		const stop = coordinator.listen();
		coordinator.signal();
		advance(STALE);
		stop();

		document.dispatchEvent(new Event('pointermove'));

		expect(refresh).toHaveBeenCalledOnce();
	});
});

describe('Which system owns a route', () => {
	it.each([
		['/agent', 'agent'],
		['/notes', 'notes'],
		['/calendar', 'calendar'],
		['/finance', 'finance'],
		['/storage', 'storage'],
		['/credentials', 'credentials'],
	])('reads %s as %s', (pathname, key) => {
		expect(activeSystem(pathname)?.key).toBe(key);
	});

	it('claims nested routes for their system', () => {
		expect(activeSystem('/notes/anything')?.key).toBe('notes');
	});

	it('leaves a screen no system owns unclaimed', () => {
		expect(activeSystem('/settings')).toBeUndefined();
		expect(activeSystem('/notesomething')).toBeUndefined();
	});
});
