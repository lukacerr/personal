import {
	classifyNoteLoadFailure,
	createNotesRefresh,
	describeNotesFailure,
} from '@web/lib/notes-refresh';
import { describe, expect, it, vi } from 'vitest';

function deps(
	overrides: Partial<Parameters<typeof createNotesRefresh>[0]> = {},
) {
	return {
		syncOutbox: vi.fn(async () => undefined),
		refreshIndex: vi.fn(async () => undefined),
		fetchNote: vi.fn(async () => undefined),
		getNoteState: vi.fn(async () => ({ dirty: false, pendingCount: 0 })),
		isOnline: () => true,
		...overrides,
	};
}

describe('Notes refresh', () => {
	it('drains the outbox before asking the server for the index', async () => {
		const order: string[] = [];
		const options = deps({
			syncOutbox: vi.fn(async () => {
				order.push('outbox');
			}),
			refreshIndex: vi.fn(async () => {
				order.push('index');
			}),
		});

		const refresh = createNotesRefresh(options);
		expect(await refresh()).toEqual({ status: 'refreshed' });
		expect(order).toEqual(['outbox', 'index']);
	});

	it('reloads the open note when it has no local work', async () => {
		const options = deps();
		const refresh = createNotesRefresh(options);

		expect(await refresh('note-1')).toEqual({ status: 'refreshed' });
		expect(options.fetchNote).toHaveBeenCalledWith('note-1');
	});

	it('keeps an unsaved draft instead of overwriting it', async () => {
		const options = deps({
			getNoteState: vi.fn(async () => ({ dirty: true, pendingCount: 0 })),
		});
		const refresh = createNotesRefresh(options);

		expect(await refresh('note-1')).toEqual({ status: 'refreshed' });
		expect(options.refreshIndex).toHaveBeenCalledOnce();
		expect(options.fetchNote).not.toHaveBeenCalled();
	});

	it('keeps a note with queued operations untouched', async () => {
		const options = deps({
			getNoteState: vi.fn(async () => ({ dirty: false, pendingCount: 1 })),
		});
		const refresh = createNotesRefresh(options);

		await refresh('note-1');
		expect(options.fetchNote).not.toHaveBeenCalled();
	});

	it('reports being offline without calling the server', async () => {
		const options = deps({ isOnline: () => false });
		const refresh = createNotesRefresh(options);

		expect(await refresh('note-1')).toEqual({ status: 'offline' });
		expect(options.syncOutbox).not.toHaveBeenCalled();
		expect(options.refreshIndex).not.toHaveBeenCalled();
	});

	it('reports a failure with its cause', async () => {
		const error = new Error('boom');
		const options = deps({
			refreshIndex: vi.fn(async () => {
				throw error;
			}),
		});
		const refresh = createNotesRefresh(options);

		expect(await refresh()).toEqual({ status: 'failed', error });
	});

	it('coalesces concurrent refreshes into a single pass', async () => {
		const options = deps();
		const refresh = createNotesRefresh(options);

		const [first, second] = await Promise.all([refresh(), refresh()]);
		expect(first).toEqual({ status: 'refreshed' });
		expect(second).toEqual({ status: 'refreshed' });
		expect(options.refreshIndex).toHaveBeenCalledOnce();
	});

	it('describes each failure cause distinctly', () => {
		expect(describeNotesFailure({ status: 'offline' })).toBe(
			'No connection. Notes will sync when you are back online.',
		);
		expect(
			describeNotesFailure({
				status: 'failed',
				error: Object.assign(new Error('conflict'), { status: 409 }),
			}),
		).toBe('Another note already uses this title in this folder.');
		expect(
			describeNotesFailure({
				status: 'failed',
				error: Object.assign(new Error('server'), { status: 500 }),
			}),
		).toBe('The server could not be reached. Try again in a moment.');
		expect(
			describeNotesFailure({ status: 'failed', error: new Error('nope') }),
		).toBe('Something went wrong. Try again in a moment.');
	});
});

/**
 * A note that cannot be opened is not one failure. Only the server can say a
 * note is gone, and treating a dropped connection as a deletion would tell the
 * user their note no longer exists while it sits safely on the server.
 */
describe('Why a note could not be opened', () => {
	it.each([
		['a deletion the server confirmed', { status: 404 }, true, 'missing'],
		['a deletion seen while offline', { status: 404 }, false, 'missing'],
		['a server error', { status: 500 }, true, 'failed'],
		['an unreachable server', { status: 500 }, false, 'offline'],
		['a dropped connection', undefined, false, 'offline'],
		['an unexplained failure', undefined, true, 'failed'],
	])('reads %s as %s', (_case, status, online, expected) => {
		const error = status
			? Object.assign(new Error('failed'), status)
			: new Error('failed');

		expect(classifyNoteLoadFailure(error, online)).toBe(expected);
	});
});
