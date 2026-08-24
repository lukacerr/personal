import type {
	CalendarCompletion,
	CalendarEvent,
	CompletionStatus,
	EventDraft,
	EventPatch,
} from '@web/lib/calendar-api';
import type { SessionWorkGuard } from '@web/lib/session-work';
import Dexie, { type Table } from 'dexie';

/**
 * Calendar's own base — nobody else's. Rows, not documents: an event is small
 * and whole, so there is no draft state and no content table. What Dexie holds
 * is the last known truth plus whatever intent is still queued, and the
 * server's last-write-wins clock (`updatedAt`) is what every merge reads.
 */

export type LocalEvent = CalendarEvent & {
	/** Set when the server rejected this event's sync in a way retrying cannot fix. */
	syncFailure?: string;
};

export type LocalCompletion = CalendarCompletion;

export type EventCreateOperation = {
	key: string;
	type: 'create';
	eventId: string;
	createdAt: number;
	draft: EventDraft;
};

export type EventPatchOperation = {
	key: string;
	type: 'patch';
	eventId: string;
	createdAt: number;
	patch: EventPatch;
};

export type EventDeleteOperation = {
	key: string;
	type: 'delete';
	eventId: string;
	createdAt: number;
};

export type CompletionOperation = {
	key: string;
	type: 'completion';
	eventId: string;
	date: string;
	/** `null` reopens the occurrence; a status resolves it. */
	status: CompletionStatus | null;
	createdAt: number;
};

export type CalendarOutboxOperation =
	| EventCreateOperation
	| EventPatchOperation
	| EventDeleteOperation
	| CompletionOperation;

export class CalendarDatabase extends Dexie {
	events!: Table<LocalEvent, string>;
	completions!: Table<LocalCompletion, [string, string]>;
	outbox!: Table<CalendarOutboxOperation, string>;

	constructor(name = 'personal-calendar:v1') {
		super(name);
		this.version(1).stores({
			events: 'id, date, createdAt',
			completions: '[eventId+date], eventId',
			outbox: '&key, eventId, createdAt',
		});
	}
}

export const calendarDb = new CalendarDatabase();

export async function clearLocalCalendar() {
	await calendarDb.transaction(
		'rw',
		calendarDb.events,
		calendarDb.completions,
		calendarDb.outbox,
		async () => {
			await calendarDb.events.clear();
			await calendarDb.completions.clear();
			await calendarDb.outbox.clear();
		},
	);
}

/**
 * The queue's own clock: strictly after everything already queued, so two
 * operations born in the same millisecond still drain in the order they were
 * made. `orderBy('createdAt')` is the only ordering the flush has.
 */
async function nextQueueClock(db: CalendarDatabase, now: number) {
	const last = await db.outbox.orderBy('createdAt').last();
	return Math.max(now, (last?.createdAt ?? 0) + 1);
}

export async function createLocalEvent(
	db: CalendarDatabase,
	draft: EventDraft,
) {
	await db.transaction('rw', db.events, db.outbox, async () => {
		await db.events.put({ ...draft, updatedAt: draft.createdAt });
		await db.outbox.put({
			key: `create:${draft.id}`,
			type: 'create',
			eventId: draft.id,
			createdAt: await nextQueueClock(db, draft.createdAt),
			draft,
		});
	});
}

/**
 * Applies the change locally and coalesces it into the one patch this event
 * has queued, if any. The edit clock must outrank both the local row and
 * whatever was already queued: a device with a slow clock still has to produce
 * an edit the server's last-write-wins resolution will accept.
 */
export async function updateLocalEvent(
	db: CalendarDatabase,
	id: string,
	changes: Omit<EventPatch, 'updatedAt'>,
	now = Date.now(),
) {
	await db.transaction('rw', db.events, db.outbox, async () => {
		const current = await db.events.get(id);
		if (!current) throw new Error(`Cannot update missing event ${id}`);

		const updatedAt = Math.max(now, current.updatedAt + 1);
		await db.events.put({
			...current,
			...changes,
			updatedAt,
			syncFailure: undefined,
		});

		const queued = await db.outbox.get(`patch:${id}`);
		const previous = queued?.type === 'patch' ? queued.patch : undefined;
		await db.outbox.put({
			key: `patch:${id}`,
			type: 'patch',
			eventId: id,
			// A coalesced patch keeps its place in the queue; only its content moves.
			createdAt: queued?.createdAt ?? (await nextQueueClock(db, now)),
			patch: { ...previous, ...changes, updatedAt },
		});
	});
}

/**
 * An event whose create is still queued was never seen by the server, so
 * deleting it locally erases every trace and sends nothing. Otherwise the
 * delete is queued and the event's stale intent — patches, completions — is
 * dropped, because none of it can matter after the row goes.
 */
export async function deleteLocalEvent(db: CalendarDatabase, id: string) {
	await db.transaction('rw', db.events, db.completions, db.outbox, async () => {
		await db.events.delete(id);
		await db.completions.where('eventId').equals(id).delete();

		const pending = await db.outbox.where('eventId').equals(id).toArray();
		await db.outbox.bulkDelete(pending.map((operation) => operation.key));

		const neverSynced = pending.some(
			(operation) => operation.type === 'create',
		);
		if (neverSynced) return;
		await db.outbox.put({
			key: `delete:${id}`,
			type: 'delete',
			eventId: id,
			createdAt: await nextQueueClock(db, Date.now()),
		});
	});
}

export async function setLocalCompletion(
	db: CalendarDatabase,
	eventId: string,
	date: string,
	status: CompletionStatus | null,
	now = Date.now(),
) {
	await db.transaction('rw', db.completions, db.outbox, async () => {
		if (status === null) await db.completions.delete([eventId, date]);
		else await db.completions.put({ eventId, date, status });

		// One key per occurrence: toggling twice offline sends only where it ended.
		await db.outbox.put({
			key: `completion:${eventId}:${date}`,
			type: 'completion',
			eventId,
			date,
			status,
			createdAt: await nextQueueClock(db, now),
		});
	});
}

/**
 * Adopts a server row unless local edits have already moved past it. The
 * guard matters twice: a create's echo must not roll back a patch still queued
 * behind it, and a stale patch answered with the server's newer row must be
 * adopted rather than fought.
 */
async function adoptServerEvent(db: CalendarDatabase, remote: CalendarEvent) {
	const local = await db.events.get(remote.id);
	if (local && local.updatedAt > remote.updatedAt) return;
	await db.events.put({ ...remote, syncFailure: undefined });
}

export async function reconcileCalendarIndex(
	db: CalendarDatabase,
	remote: { events: CalendarEvent[]; completions: CalendarCompletion[] },
	isCurrent: SessionWorkGuard = () => true,
) {
	await db.transaction('rw', db.events, db.completions, db.outbox, async () => {
		if (!isCurrent()) return;
		const pending = await db.outbox.toArray();
		const pendingEventIds = new Set(
			pending.map((operation) => operation.eventId),
		);
		const pendingCompletionKeys = new Set(
			pending
				.filter((operation) => operation.type === 'completion')
				.map((operation) => operation.key),
		);
		const serverIds = new Set(remote.events.map((event) => event.id));

		for (const event of remote.events) {
			const local = await db.events.get(event.id);
			// Local wins only while its intent is still queued; once the queue is
			// clean the server is the truth, which also heals a terminal divergence.
			if (
				local &&
				pendingEventIds.has(event.id) &&
				local.updatedAt > event.updatedAt
			)
				continue;
			await db.events.put({ ...event, syncFailure: local?.syncFailure });
		}

		for (const local of await db.events.toArray()) {
			if (serverIds.has(local.id) || pendingEventIds.has(local.id)) continue;
			await db.events.delete(local.id);
			await db.completions.where('eventId').equals(local.id).delete();
		}

		const remoteKeys = new Set(
			remote.completions.map((row) => `completion:${row.eventId}:${row.date}`),
		);
		for (const row of await db.completions.toArray()) {
			const key = `completion:${row.eventId}:${row.date}`;
			if (pendingCompletionKeys.has(key) || remoteKeys.has(key)) continue;
			await db.completions.delete([row.eventId, row.date]);
		}
		for (const row of remote.completions) {
			if (pendingCompletionKeys.has(`completion:${row.eventId}:${row.date}`))
				continue;
			if (!(await db.events.get(row.eventId))) continue;
			await db.completions.put(row);
		}
	});
}

export type CalendarSyncFailure = {
	operation: CalendarOutboxOperation;
	error: unknown;
};

/**
 * A terminal error is one retrying can never resolve. Leaving it queued would
 * stall every later operation forever, so it is dropped and recorded on the
 * event instead — visible, not silent.
 */
function isTerminalSyncError(error: unknown) {
	return (
		(error as { terminal?: boolean } | null | undefined)?.terminal === true
	);
}

async function discardOperation(
	db: CalendarDatabase,
	{ operation, error }: CalendarSyncFailure,
) {
	const reason = error instanceof Error ? error.message : 'Sync was rejected';
	await db.transaction('rw', db.events, db.outbox, async () => {
		await db.outbox.delete(operation.key);
		await db.events
			.where('id')
			.equals(operation.eventId)
			.modify((event) => {
				event.syncFailure = reason;
			});
	});
}

export async function flushCalendarOutbox(
	db: CalendarDatabase,
	send: (
		operation: CalendarOutboxOperation,
	) => Promise<CalendarEvent | undefined>,
	isCurrent: SessionWorkGuard = () => true,
) {
	const operations = await db.outbox.orderBy('createdAt').toArray();
	const discarded: CalendarSyncFailure[] = [];

	for (const operation of operations) {
		try {
			const remote = await send(operation);
			if (!isCurrent())
				return { failed: undefined, discarded, cancelled: true };
			await db.transaction('rw', db.events, db.outbox, async () => {
				if (!isCurrent()) return;
				// A patch coalesced while this one was in flight has a newer clock
				// and must stay queued; deleting by key alone would drop that edit.
				const current = await db.outbox.get(operation.key);
				if (
					current &&
					(current.type !== 'patch' ||
						operation.type !== 'patch' ||
						current.patch.updatedAt === operation.patch.updatedAt)
				)
					await db.outbox.delete(operation.key);
				if (remote) await adoptServerEvent(db, remote);
			});
		} catch (error) {
			const failure = { operation, error };
			if (!isTerminalSyncError(error)) return { failed: failure, discarded };
			await discardOperation(db, failure);
			discarded.push(failure);
		}
	}

	return { failed: undefined, discarded, cancelled: false };
}

export function createCalendarOutboxSynchronizer(
	db: CalendarDatabase,
	send: (
		operation: CalendarOutboxOperation,
	) => Promise<CalendarEvent | undefined>,
) {
	let activeSync: Promise<CalendarSyncFailure[]> | undefined;
	return function synchronize(isCurrent: SessionWorkGuard = () => true) {
		if (activeSync) return activeSync;
		activeSync = (async () => {
			const discarded: CalendarSyncFailure[] = [];
			while ((await db.outbox.count()) > 0) {
				const result = await flushCalendarOutbox(db, send, isCurrent);
				discarded.push(...result.discarded);
				if (result.cancelled) return discarded;
				if (result.failed) throw result.failed.error;
			}
			return discarded;
		})().finally(() => {
			activeSync = undefined;
		});
		return activeSync;
	};
}
