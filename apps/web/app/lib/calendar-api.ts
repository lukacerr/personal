import { isTransientApiFailure } from '@web/lib/api';
import { authenticatedApi } from '@web/lib/authenticated-api';
import type { CalendarSettings } from '@web/lib/calendar-settings';
import { conditionalGet } from '@web/lib/http-conditional';
import type { TreatyData } from '@web/lib/treaty-data';

type EventsIndex = Extract<
	TreatyData<typeof authenticatedApi.events.get>,
	{ events: unknown[] }
>;

/** The contract itself, never a hand-written copy of it. */
export type CalendarEvent = EventsIndex['events'][number];
export type CalendarCompletion = EventsIndex['completions'][number];
export type EventRecurrence = NonNullable<CalendarEvent['recurrence']>;
export type CompletionStatus = CalendarCompletion['status'];

/**
 * Everything the client decides about an event. The id and the creation
 * instant come from the device so an event exists offline before the server
 * hears of it, and retrying a lost create converges on the same row.
 */
export type EventDraft = {
	id: string;
	title: string;
	details: string | null;
	tag: string | null;
	date: string | null;
	timeMinutes: number | null;
	recurrence: EventRecurrence | null;
	completedAt: number | null;
	createdAt: number;
};

export type EventPatch = Partial<Omit<EventDraft, 'id' | 'createdAt'>> & {
	/** The client's edit clock; the server resolves concurrent edits with it. */
	updatedAt: number;
};

const terminalMessages: Record<number, string> = {
	404: 'This event no longer exists on the server.',
	422: 'The server rejected this event as invalid.',
};

export class CalendarApiError extends Error {
	/**
	 * Client errors other than timeouts and rate limits will fail identically on
	 * every retry, so the outbox drops them instead of stalling behind them.
	 */
	readonly terminal: boolean;

	constructor(readonly status: number) {
		super(terminalMessages[status] ?? `Calendar API returned ${status}`);
		this.terminal =
			status >= 400 && status < 500 && !isTransientApiFailure(status);
	}
}

function asEvent(data: unknown, status: number) {
	if (status < 200 || status >= 300 || !data || !('title' in (data as object)))
		throw new CalendarApiError(status);
	return data as CalendarEvent;
}

/** The index, or word that the copy already held is still current. */
export function listEvents(
	knownTag?: string,
): Promise<
	| { events: CalendarEvent[]; completions: CalendarCompletion[]; tag?: string }
	| 'unchanged'
> {
	return conditionalGet(
		knownTag,
		(conditional) => authenticatedApi.events.get(conditional),
		(response) => {
			if (
				response.status !== 200 ||
				!response.data ||
				!('events' in response.data)
			)
				throw new CalendarApiError(response.status);
			return {
				events: response.data.events,
				completions: response.data.completions,
			};
		},
	);
}

/**
 * The shared view settings — groups and hidden tags.
 *
 * A read that cannot be answered comes back `null`, the same as a cache with
 * nothing in it: both mean "no shared copy to adopt", and the screen falls
 * through to what this device remembered. A write says whether it landed, so
 * the caller can tell saved-everywhere apart from saved-here.
 */
export async function readSharedCalendarSettings(): Promise<CalendarSettings | null> {
	const response = await authenticatedApi.events.settings.get();
	if (response.status !== 200 || !response.data) return null;
	return response.data.settings;
}

export async function writeSharedCalendarSettings(settings: CalendarSettings) {
	const response = await authenticatedApi.events.settings.put(settings);
	return response.status === 200;
}

export async function createEvent(draft: EventDraft) {
	const response = await authenticatedApi.events.post(draft);
	return asEvent(response.data, response.status);
}

export async function updateEvent(id: string, changes: EventPatch) {
	const response = await authenticatedApi.events({ id }).patch(changes);
	return asEvent(response.data, response.status);
}

export async function deleteEvent(id: string) {
	const response = await authenticatedApi.events({ id }).delete();
	if (response.status !== 204) throw new CalendarApiError(response.status);
}

export async function putCompletion(
	eventId: string,
	date: string,
	status: CompletionStatus,
) {
	const response = await authenticatedApi
		.events({ id: eventId })
		.completions({ date })
		.put({ status });
	if (response.status !== 200) throw new CalendarApiError(response.status);
}

export async function removeCompletion(eventId: string, date: string) {
	const response = await authenticatedApi
		.events({ id: eventId })
		.completions({ date })
		.delete();
	if (response.status !== 204) throw new CalendarApiError(response.status);
}
