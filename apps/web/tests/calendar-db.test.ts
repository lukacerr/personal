import 'fake-indexeddb/auto';
import { CalendarApiError } from '@web/lib/calendar-api';
import {
	CalendarDatabase,
	createLocalEvent,
	deleteLocalEvent,
	flushCalendarOutbox,
	type LocalEvent,
	reconcileCalendarIndex,
	setLocalCompletion,
	updateLocalEvent,
} from '@web/lib/calendar-db';
import { afterEach, describe, expect, it } from 'vitest';

const databases: CalendarDatabase[] = [];

function newDb() {
	const db = new CalendarDatabase(
		`personal-calendar-test:${databases.length}:${Date.now()}`,
	);
	databases.push(db);
	return db;
}

afterEach(async () => {
	await Promise.all(databases.map((db) => db.delete()));
	databases.length = 0;
});

function makeDraft(overrides: Record<string, unknown> = {}) {
	return {
		id: crypto.randomUUID(),
		title: 'Rosita',
		details: null,
		tag: null,
		date: null,
		timeMinutes: null,
		recurrence: null,
		completedAt: null,
		createdAt: 1_000,
		...overrides,
	};
}

/** A row the server already confirmed: present locally with no queued intent. */
async function seedSynced(
	db: CalendarDatabase,
	overrides: Record<string, unknown> = {},
) {
	const row = {
		...makeDraft(),
		updatedAt: 1_000,
		...overrides,
	} as LocalEvent;
	await db.events.put(row);
	return row;
}

describe('local writes', () => {
	it('shows a created event immediately and queues exactly one create', async () => {
		const db = newDb();
		const draft = makeDraft({ date: '2026-08-18', timeMinutes: 480 });

		await createLocalEvent(db, draft);

		const row = await db.events.get(draft.id);
		expect(row).toMatchObject({ title: 'Rosita', updatedAt: 1_000 });
		const operations = await db.outbox.toArray();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({ type: 'create', eventId: draft.id });
	});

	it('coalesces edits into one queued patch whose clock only moves forward', async () => {
		const db = newDb();
		// The device clock sits behind the row on purpose.
		const synced = await seedSynced(db, { updatedAt: 5_000 });

		await updateLocalEvent(db, synced.id, { title: 'Rosita vet' }, 1_000);
		await updateLocalEvent(db, synced.id, { timeMinutes: 510 }, 1_000);

		const operations = await db.outbox.toArray();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({
			type: 'patch',
			patch: { title: 'Rosita vet', timeMinutes: 510, updatedAt: 5_002 },
		});
		expect((await db.events.get(synced.id))?.updatedAt).toBe(5_002);
	});

	it('queues an edit behind an unsent create instead of into it', async () => {
		const db = newDb();
		const draft = makeDraft();

		await createLocalEvent(db, draft);
		await updateLocalEvent(db, draft.id, { title: 'Renamed' }, 2_000);

		const operations = await db.outbox.orderBy('createdAt').toArray();
		expect(operations.map((operation) => operation.type)).toEqual([
			'create',
			'patch',
		]);
	});

	it('leaves no trace when deleting an event the server never saw', async () => {
		const db = newDb();
		const draft = makeDraft();

		await createLocalEvent(db, draft);
		await deleteLocalEvent(db, draft.id);

		expect(await db.events.count()).toBe(0);
		expect(await db.outbox.count()).toBe(0);
	});

	it('queues a delete for a synced event and drops its now-pointless ops', async () => {
		const db = newDb();
		const synced = await seedSynced(db, {
			date: '2026-08-18',
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		await updateLocalEvent(db, synced.id, { title: 'Doomed' }, 2_000);
		await setLocalCompletion(db, synced.id, '2026-08-19', 'done', 3_000);

		await deleteLocalEvent(db, synced.id);

		expect(await db.events.count()).toBe(0);
		expect(await db.completions.count()).toBe(0);
		const operations = await db.outbox.toArray();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({ type: 'delete', eventId: synced.id });
	});

	it('checks and unchecks an occurrence through one coalesced operation', async () => {
		const db = newDb();
		const synced = await seedSynced(db, {
			date: '2026-08-01',
			recurrence: { kind: 'everyDays', interval: 1 },
		});

		await setLocalCompletion(db, synced.id, '2026-08-19', 'done', 2_000);
		expect(await db.completions.get([synced.id, '2026-08-19'])).toMatchObject({
			status: 'done',
		});

		await setLocalCompletion(db, synced.id, '2026-08-19', null, 3_000);
		expect(await db.completions.get([synced.id, '2026-08-19'])).toBeUndefined();

		const operations = await db.outbox.toArray();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({
			type: 'completion',
			date: '2026-08-19',
			status: null,
		});
	});
});

describe('reconcileCalendarIndex', () => {
	it('adopts the server, keeps pending intent, drops what was deleted elsewhere', async () => {
		const db = newDb();
		const stale = await seedSynced(db, {
			title: 'Old title',
			updatedAt: 1_000,
		});
		const deletedElsewhere = await seedSynced(db);
		const pendingCreate = makeDraft({ title: 'Offline only' });
		await createLocalEvent(db, pendingCreate);

		const remoteNew = {
			...makeDraft({ title: 'From another device' }),
			updatedAt: 1_000,
		};
		await reconcileCalendarIndex(db, {
			events: [
				{ ...stale, title: 'Renamed remotely', updatedAt: 2_000 },
				remoteNew,
			] as LocalEvent[],
			completions: [],
		});

		expect((await db.events.get(stale.id))?.title).toBe('Renamed remotely');
		expect(await db.events.get(deletedElsewhere.id)).toBeUndefined();
		expect((await db.events.get(pendingCreate.id))?.title).toBe('Offline only');
		expect((await db.events.get(remoteNew.id))?.title).toBe(
			'From another device',
		);
	});

	it('keeps a local edit that is still queued and newer than the server copy', async () => {
		const db = newDb();
		const synced = await seedSynced(db, { updatedAt: 1_000 });
		await updateLocalEvent(db, synced.id, { title: 'Local newer' }, 5_000);

		await reconcileCalendarIndex(db, {
			events: [
				{ ...synced, title: 'Server older', updatedAt: 2_000 },
			] as LocalEvent[],
			completions: [],
		});

		expect((await db.events.get(synced.id))?.title).toBe('Local newer');
	});

	it('mirrors server completions except where local intent is still queued', async () => {
		const db = newDb();
		const synced = await seedSynced(db, {
			date: '2026-08-01',
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		// Confirmed long ago, and meanwhile unchecked on the server.
		await db.completions.put({
			eventId: synced.id,
			date: '2026-08-10',
			status: 'done',
		});
		// Still queued: this device just checked the 11th; the server does not
		// know yet and must not erase it.
		await setLocalCompletion(db, synced.id, '2026-08-11', 'done', 2_000);

		await reconcileCalendarIndex(db, {
			events: [synced],
			completions: [{ eventId: synced.id, date: '2026-08-12', status: 'done' }],
		});

		expect(await db.completions.get([synced.id, '2026-08-10'])).toBeUndefined();
		expect((await db.completions.get([synced.id, '2026-08-11']))?.status).toBe(
			'done',
		);
		expect((await db.completions.get([synced.id, '2026-08-12']))?.status).toBe(
			'done',
		);
	});
});

describe('flushCalendarOutbox', () => {
	it('sends in queue order and adopts the returned rows', async () => {
		const db = newDb();
		const draft = makeDraft();
		await createLocalEvent(db, draft);
		await updateLocalEvent(db, draft.id, { title: 'Final' }, 2_000);

		const sent: string[] = [];
		const { failed } = await flushCalendarOutbox(db, async (operation) => {
			sent.push(operation.type);
			if (operation.type === 'create')
				return { ...draft, updatedAt: draft.createdAt } as LocalEvent;
			if (operation.type === 'patch')
				return { ...draft, title: 'Final', updatedAt: 2_000 } as LocalEvent;
			return undefined;
		});

		expect(failed).toBeUndefined();
		expect(sent).toEqual(['create', 'patch']);
		expect(await db.outbox.count()).toBe(0);
		expect((await db.events.get(draft.id))?.title).toBe('Final');
	});

	it('never lets a server echo roll the row back behind queued edits', async () => {
		const db = newDb();
		const draft = makeDraft();
		await createLocalEvent(db, draft);
		await updateLocalEvent(db, draft.id, { title: 'Newer local' }, 5_000);

		// Only the create drains; the patch stays queued behind it.
		await flushCalendarOutbox(db, async (operation) => {
			if (operation.type === 'create')
				return { ...draft, updatedAt: draft.createdAt } as LocalEvent;
			throw new CalendarApiError(500);
		});

		expect((await db.events.get(draft.id))?.title).toBe('Newer local');
	});

	it('stops on a transient failure and keeps the operation queued', async () => {
		const db = newDb();
		await createLocalEvent(db, makeDraft());

		const { failed } = await flushCalendarOutbox(db, async () => {
			throw new CalendarApiError(503);
		});

		expect(failed).toBeDefined();
		expect(await db.outbox.count()).toBe(1);
	});

	it('discards a terminal rejection, records it on the event, and moves on', async () => {
		const db = newDb();
		const rejected = await seedSynced(db, { updatedAt: 1_000 });
		const fine = makeDraft({ title: 'Fine' });
		await updateLocalEvent(db, rejected.id, { title: 'Invalid' }, 2_000);
		await createLocalEvent(db, fine);

		const sent: string[] = [];
		const { failed, discarded } = await flushCalendarOutbox(
			db,
			async (operation) => {
				sent.push(operation.type);
				if (operation.type === 'patch') throw new CalendarApiError(422);
				return { ...fine, updatedAt: fine.createdAt } as LocalEvent;
			},
		);

		expect(failed).toBeUndefined();
		expect(discarded).toHaveLength(1);
		expect(sent).toEqual(['patch', 'create']);
		expect(await db.outbox.count()).toBe(0);
		expect((await db.events.get(rejected.id))?.syncFailure).toBeTruthy();
	});
});
