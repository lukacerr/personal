import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CALENDAR_SETTINGS_KEY } from '@api/calendar-settings';
import { cache, db } from '@api/env';
import { app } from '@api/index';
import { event } from '@api/schema';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';

async function request(path: string, init?: RequestInit) {
	return app.handle(new Request(`http://localhost${path}`, init));
}

async function json(path: string, method: string, body: unknown) {
	return request(path, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

type EventRecurrence =
	| { kind: 'everyDays'; interval: number; until?: string }
	| { kind: 'weekly'; weekdays: number[]; until?: string };

type EventBody = {
	id: string;
	title: string;
	details: string | null;
	tag: string | null;
	date: string | null;
	timeMinutes: number | null;
	recurrence: EventRecurrence | null;
	completedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

type EventCompletionBody = {
	eventId: string;
	date: string;
	status: 'done';
};

type EventIndexBody = {
	events: EventBody[];
	completions: EventCompletionBody[];
};

const createdIds = new Set<string>();

async function create(body: Record<string, unknown>) {
	const id = (body.id as string) ?? crypto.randomUUID();
	createdIds.add(id);
	const response = await json('/events', 'POST', {
		id,
		title: `Event ${randomUUIDv7()}`,
		...body,
	});
	return {
		response,
		body: (await response.json()) as EventBody & { error?: string },
	};
}

afterEach(async () => {
	if (createdIds.size > 0)
		await db.delete(event).where(inArray(event.id, [...createdIds]));
	createdIds.clear();
});

describe('events', () => {
	it('creates a backlog item: no date, no time, nothing else required', async () => {
		const { response, body } = await create({});

		expect(response.status).toBe(201);
		expect(body).toMatchObject({
			date: null,
			timeMinutes: null,
			recurrence: null,
			details: null,
			completedAt: null,
		});
		expect(typeof body.createdAt).toBe('number');
		expect(body.updatedAt).toBe(body.createdAt);
	});

	it('creates a dated, timed event with details', async () => {
		const { response, body } = await create({
			date: '2026-08-27',
			timeMinutes: 9 * 60,
			details: 'Launch + retro',
		});

		expect(response.status).toBe(201);
		expect(body).toMatchObject({
			date: '2026-08-27',
			timeMinutes: 540,
			details: 'Launch + retro',
		});
	});

	/**
	 * The outbox retries a create whose response was lost. The second attempt
	 * must return the row that already exists instead of duplicating or failing.
	 */
	it('retrying a create with the same id returns the existing row', async () => {
		const id = crypto.randomUUID();
		const first = await create({ id, title: 'Once', date: '2026-09-01' });
		const again = await create({ id, title: 'Twice' });

		expect(first.response.status).toBe(201);
		expect(again.response.status).toBe(200);
		expect(again.body.id).toBe(id);
		expect(again.body.title).toBe('Once');

		const index = await request('/events');
		const { events } = (await index.json()) as EventIndexBody;
		expect(events.filter((row) => row.id === id)).toHaveLength(1);
	});

	it('dates an offline-created event by its client clock, not by the sync', async () => {
		const createdAt = Date.UTC(2026, 7, 1, 12);
		const { body } = await create({ createdAt });

		expect(body.createdAt).toBe(createdAt);
		expect(body.updatedAt).toBe(createdAt);
	});

	it('refuses a time on an event with no date', async () => {
		const { response, body } = await create({ timeMinutes: 600 });

		expect(response.status).toBe(422);
		expect(body.error).toBe('EVENT_TIME_REQUIRES_DATE');
	});

	it('refuses recurrence on an event with no date', async () => {
		const { response, body } = await create({
			recurrence: { kind: 'everyDays', interval: 3 },
		});

		expect(response.status).toBe(422);
		expect(body.error).toBe('EVENT_RECURRENCE_REQUIRES_DATE');
	});

	it('refuses a recurrence that ends before it starts', async () => {
		const { response, body } = await create({
			date: '2026-09-10',
			recurrence: { kind: 'everyDays', interval: 1, until: '2026-09-09' },
		});

		expect(response.status).toBe(422);
		expect(body.error).toBe('EVENT_RECURRENCE_ENDS_BEFORE_START');
	});

	it('refuses a row-level completion on a recurring event', async () => {
		const { response, body } = await create({
			date: '2026-09-10',
			recurrence: { kind: 'weekly', weekdays: [2, 4] },
			completedAt: Date.now(),
		});

		expect(response.status).toBe(422);
		expect(body.error).toBe('EVENT_COMPLETED_AT_ON_RECURRING');
	});

	it.each([
		['a zero interval', { kind: 'everyDays', interval: 0 }],
		['a fractional interval', { kind: 'everyDays', interval: 1.5 }],
		['an out-of-range weekday', { kind: 'weekly', weekdays: [8] }],
		['a repeated weekday', { kind: 'weekly', weekdays: [2, 2] }],
		['an empty weekday set', { kind: 'weekly', weekdays: [] }],
		['an unknown kind', { kind: 'monthly', interval: 1 }],
	])('refuses %s', async (_case, recurrence) => {
		const { response } = await create({ date: '2026-09-10', recurrence });
		expect(response.status).toBe(422);
	});

	it.each([
		['a date that does not exist', '2026-02-30'],
		['a date in the wrong shape', '27/08/2026'],
	])('refuses %s', async (_case, date) => {
		const { response } = await create({ date });
		expect(response.status).toBe(422);
	});

	it('marks a one-off done and pending again through PATCH', async () => {
		const completedAt = Date.UTC(2026, 7, 20, 15);
		const { body } = await create({ date: '2026-08-20' });

		const done = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1,
			completedAt,
		});
		expect(done.status).toBe(200);
		expect(((await done.json()) as EventBody).completedAt).toBe(completedAt);

		const undone = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 2,
			completedAt: null,
		});
		expect(((await undone.json()) as EventBody).completedAt).toBeNull();
	});

	/**
	 * Two devices edit the same event offline. Whichever edit is newer must win
	 * regardless of arrival order, so a stale patch is ignored and answered with
	 * the stored row for the client to adopt.
	 */
	it('resolves concurrent edits by client edit time, not arrival order', async () => {
		const { body } = await create({ date: '2026-09-01' });

		const newer = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 2_000,
			title: 'Newer edit',
		});
		expect(newer.status).toBe(200);

		const stale = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1_000,
			title: 'Older edit',
		});
		expect(stale.status).toBe(200);
		const settled = (await stale.json()) as EventBody;
		expect(settled.title).toBe('Newer edit');
		expect(settled.updatedAt).toBe(body.updatedAt + 2_000);
	});

	it('refuses an edit clock past what Date can represent', async () => {
		const { body } = await create({});
		const response = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: 8_640_000_000_000_001,
			title: 'Forever the winner',
		});
		expect(response.status).toBe(422);
	});

	it('checks merged invariants when patching, not just the fields sent', async () => {
		const { body } = await create({ date: '2026-09-01', timeMinutes: 300 });

		// Clearing the date alone would strand the time on a backlog item.
		const response = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1,
			date: null,
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'EVENT_TIME_REQUIRES_DATE',
		});
	});

	it('moves an event to the backlog when date and time clear together', async () => {
		const { body } = await create({ date: '2026-09-01', timeMinutes: 300 });

		const response = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1,
			date: null,
			timeMinutes: null,
		});

		expect(response.status).toBe(200);
		expect((await response.json()) as EventBody).toMatchObject({
			date: null,
			timeMinutes: null,
		});
	});

	it('reports an unknown id as missing on PATCH', async () => {
		const response = await json(`/events/${crypto.randomUUID()}`, 'PATCH', {
			updatedAt: Date.now(),
			title: 'Ghost',
		});
		expect(response.status).toBe(404);
	});

	it('deletes idempotently', async () => {
		const { body } = await create({});

		expect(
			(await request(`/events/${body.id}`, { method: 'DELETE' })).status,
		).toBe(204);
		expect(
			(await request(`/events/${body.id}`, { method: 'DELETE' })).status,
		).toBe(204);
	});

	it('carries a tag, and clearing it needs an explicit null', async () => {
		const { response, body } = await create({ tag: 'uade' });
		expect(response.status).toBe(201);
		expect(body.tag).toBe('uade');

		const untouched = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1,
			title: 'Renamed',
		});
		expect(((await untouched.json()) as EventBody).tag).toBe('uade');

		const cleared = await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 2,
			tag: null,
		});
		expect(((await cleared.json()) as EventBody).tag).toBeNull();
	});

	it('refuses a blank tag', async () => {
		const { response } = await create({ tag: '   ' });
		expect(response.status).toBe(422);
	});
});

describe('calendar settings', () => {
	// Cleared on the way in too: the local Redis is shared with the running
	// app, which may have stored real settings before the suite ran.
	beforeEach(async () => {
		await cache.del(CALENDAR_SETTINGS_KEY);
	});

	afterEach(async () => {
		await cache.del(CALENDAR_SETTINGS_KEY);
	});

	it('answers null while the cache holds nothing', async () => {
		const response = await request('/events/settings');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ settings: null });
	});

	it('round-trips groups and hidden tags, and cleared is not absent', async () => {
		const settings = {
			groups: [{ from: '2026-08-22', to: '2026-08-24', label: '週末' }],
			hiddenTags: ['uade'],
			hideUntagged: true,
		};

		const stored = await json('/events/settings', 'PUT', settings);
		expect(stored.status).toBe(200);
		expect(await stored.json()).toEqual({ settings });

		const read = await request('/events/settings');
		expect(await read.json()).toEqual({ settings });

		// `{}` is a value — how clearing travels — never collapsed into `null`.
		await json('/events/settings', 'PUT', {});
		const cleared = await request('/events/settings');
		expect(await cleared.json()).toEqual({ settings: {} });
	});

	it('refuses a group that ends before it starts', async () => {
		const response = await json('/events/settings', 'PUT', {
			groups: [{ from: '2026-08-24', to: '2026-08-22' }],
		});
		expect(response.status).toBe(422);
	});
});

describe('event completions', () => {
	async function createRecurring(extra: Record<string, unknown> = {}) {
		return create({
			date: '2026-08-18',
			timeMinutes: 9 * 60 + 30,
			recurrence: { kind: 'everyDays', interval: 1 },
			...extra,
		});
	}

	it('checks an occurrence, retoggles it, and unchecks idempotently', async () => {
		const { body } = await createRecurring();

		const checked = await json(
			`/events/${body.id}/completions/2026-08-19`,
			'PUT',
			{ status: 'done' },
		);
		expect(checked.status).toBe(200);
		expect((await checked.json()) as EventCompletionBody).toMatchObject({
			eventId: body.id,
			date: '2026-08-19',
			status: 'done',
		});

		// Re-checking is an upsert, not a second row.
		const again = await json(
			`/events/${body.id}/completions/2026-08-19`,
			'PUT',
			{ status: 'done' },
		);
		expect(again.status).toBe(200);

		const index = await request('/events');
		const { completions } = (await index.json()) as EventIndexBody;
		expect(completions.filter((row) => row.eventId === body.id)).toHaveLength(
			1,
		);

		const remove = () =>
			request(`/events/${body.id}/completions/2026-08-19`, {
				method: 'DELETE',
			});
		expect((await remove()).status).toBe(204);
		expect((await remove()).status).toBe(204);
	});

	it('refuses a completion on an event that does not recur', async () => {
		const { body } = await create({ date: '2026-08-20' });

		const response = await json(
			`/events/${body.id}/completions/2026-08-20`,
			'PUT',
			{ status: 'done' },
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: 'EVENT_NOT_RECURRING' });
	});

	it('reports an unknown event as missing', async () => {
		const response = await json(
			`/events/${crypto.randomUUID()}/completions/2026-08-19`,
			'PUT',
			{ status: 'done' },
		);
		expect(response.status).toBe(404);
	});

	it.each([
		['an invalid status', '2026-08-19', { status: 'later' }],
		['a malformed date', '19-08-2026', { status: 'done' }],
		['a date that does not exist', '2026-02-30', { status: 'done' }],
	])('refuses %s', async (_case, date, body) => {
		const { body: created } = await createRecurring();
		const response = await json(
			`/events/${created.id}/completions/${date}`,
			'PUT',
			body,
		);
		expect(response.status).toBe(422);
	});
});

describe('events index', () => {
	it('serves events with their completions and revalidates by entity tag', async () => {
		const { body } = await create({
			date: '2026-08-18',
			recurrence: { kind: 'weekly', weekdays: [2] },
		});
		await json(`/events/${body.id}/completions/2026-08-18`, 'PUT', {
			status: 'done',
		});

		const first = await request('/events');
		const tag = first.headers.get('etag');
		expect(first.status).toBe(200);
		expect(tag).toBeTruthy();

		const index = (await first.json()) as EventIndexBody;
		expect(index.events.some((row) => row.id === body.id)).toBe(true);
		expect(
			index.completions.some(
				(row) => row.eventId === body.id && row.status === 'done',
			),
		).toBe(true);

		const repeated = await request('/events', {
			headers: { 'if-none-match': tag ?? '' },
		});
		expect(repeated.status).toBe(304);
		expect(await repeated.text()).toBe('');

		await json(`/events/${body.id}`, 'PATCH', {
			updatedAt: body.updatedAt + 1,
			title: 'Renamed',
		});
		const afterChange = await request('/events', {
			headers: { 'if-none-match': tag ?? '' },
		});
		expect(afterChange.status).toBe(200);
	});

	it('drops completions with their event', async () => {
		const { body } = await create({
			date: '2026-08-18',
			recurrence: { kind: 'everyDays', interval: 2 },
		});
		await json(`/events/${body.id}/completions/2026-08-20`, 'PUT', {
			status: 'done',
		});

		await request(`/events/${body.id}`, { method: 'DELETE' });

		const index = await request('/events');
		const { events, completions } = (await index.json()) as EventIndexBody;
		expect(events.some((row) => row.id === body.id)).toBe(false);
		expect(completions.some((row) => row.eventId === body.id)).toBe(false);
	});
});
