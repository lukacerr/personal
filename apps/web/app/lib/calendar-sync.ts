import {
	type CalendarEvent,
	createEvent,
	deleteEvent,
	listEvents,
	putCompletion,
	removeCompletion,
	updateEvent,
} from '@web/lib/calendar-api';
import {
	type CalendarOutboxOperation,
	type CalendarSyncFailure,
	calendarDb,
	createCalendarOutboxSynchronizer,
	reconcileCalendarIndex,
} from '@web/lib/calendar-db';

/**
 * The transport under the outbox: one queued operation, one request. All the
 * decisions — ordering, coalescing, what is terminal, what the row adopts —
 * live in `calendar-db.ts`, where they are pure enough to test.
 */
async function sendCalendarOperation(
	operation: CalendarOutboxOperation,
): Promise<CalendarEvent | undefined> {
	switch (operation.type) {
		case 'create':
			return createEvent(operation.draft);
		case 'patch':
			return updateEvent(operation.eventId, operation.patch);
		case 'delete':
			await deleteEvent(operation.eventId);
			return undefined;
		case 'completion':
			if (operation.status === null)
				await removeCompletion(operation.eventId, operation.date);
			else
				await putCompletion(
					operation.eventId,
					operation.date,
					operation.status,
				);
			return undefined;
	}
}

const synchronizeOutbox = createCalendarOutboxSynchronizer(
	calendarDb,
	sendCalendarOperation,
);

export function syncCalendarOutbox() {
	return synchronizeOutbox();
}

/**
 * What the server last called the index, so a refresh that changed nothing
 * costs a round trip and no payload. Held in memory rather than persisted: a
 * cold start has no cached rows to validate it against anyway.
 */
let eventsIndexTag: string | undefined;

export type CalendarRefreshResult =
	| { status: 'refreshed'; discarded: CalendarSyncFailure[] }
	| { status: 'offline' }
	| { status: 'failed'; error: unknown };

export type CalendarRefreshFailure = Exclude<
	CalendarRefreshResult,
	{ status: 'refreshed' }
>;

let activeRefresh: Promise<CalendarRefreshResult> | undefined;

/**
 * Drains local intent first, then pulls the index. Concurrent callers share
 * one run. The automatic triggers only fire on mount, on reconnect and when
 * the tab becomes visible, so the screen also exposes this manually.
 */
export function refreshCalendar(): Promise<CalendarRefreshResult> {
	if (activeRefresh) return activeRefresh;
	if (!navigator.onLine) return Promise.resolve({ status: 'offline' as const });

	activeRefresh = (async (): Promise<CalendarRefreshResult> => {
		try {
			// Local work ships first, so the index cannot answer with rows this
			// device is about to overwrite anyway.
			const discarded = await syncCalendarOutbox();
			const result = await listEvents(eventsIndexTag);
			if (result !== 'unchanged') {
				eventsIndexTag = result.tag;
				await reconcileCalendarIndex(calendarDb, result);
			}
			return { status: 'refreshed', discarded };
		} catch (error) {
			return { status: 'failed', error };
		}
	})().finally(() => {
		activeRefresh = undefined;
	});

	return activeRefresh;
}

/** Keeps distinct causes distinguishable instead of one generic failure text. */
export function describeCalendarFailure(failure: CalendarRefreshFailure) {
	if (failure.status === 'offline')
		return 'No connection. Calendar will sync when you are back online.';

	const status = (failure.error as { status?: number } | null | undefined)
		?.status;
	if (status && status >= 500)
		return 'The server could not be reached. Try again in a moment.';
	return 'Something went wrong. Try again in a moment.';
}

/** What a discarded operation should tell the user, right where it failed. */
export function describeDiscardedSync(failure: CalendarSyncFailure) {
	const reason =
		failure.error instanceof Error
			? failure.error.message
			: 'The server rejected it.';
	return `A calendar change could not be saved: ${reason}`;
}
