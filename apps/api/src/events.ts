import { authPlugin } from '@api/auth';
import {
	calendarSettingsSchema,
	calendarSettingsStore,
	localDate,
} from '@api/calendar-settings';
import { db } from '@api/env';
import { entityTag, isUnchanged } from '@api/http-cache';
import { event, eventCompletion } from '@api/schema';
import type { EventRecurrence } from '@api/schema/event';
import { and, eq } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const eventId = z.uuid();
const eventTitle = z.string().trim().min(1).max(255);
const eventDetails = z.string().trim().min(1).max(4096).nullable();
const eventTag = z.string().trim().min(1).max(64).nullable();

/** Largest instant `Date` can represent, so a timestamp never becomes `Invalid Date`. */
const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;
const timestampMs = z.number().int().nonnegative().max(TIMESTAMP_MAX_MS);

const timeMinutes = z
	.number()
	.int()
	.min(0)
	.max(24 * 60 - 1);

const recurrence: z.ZodType<EventRecurrence> = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('everyDays'),
		interval: z.number().int().min(1).max(365),
		until: localDate.optional(),
	}),
	z.object({
		kind: z.literal('weekly'),
		weekdays: z
			.array(z.number().int().min(1).max(7))
			.min(1)
			.max(7)
			.refine(
				(days) => new Set(days).size === days.length,
				'Weekdays must be unique',
			),
		until: localDate.optional(),
	}),
]);

const eventColumns = {
	id: event.id,
	title: event.title,
	details: event.details,
	tag: event.tag,
	date: event.date,
	timeMinutes: event.timeMinutes,
	recurrence: event.recurrence,
	completedAt: event.completedAt,
	createdAt: event.createdAt,
	updatedAt: event.updatedAt,
};

type EventRow = {
	id: string;
	title: string;
	details: string | null;
	tag: string | null;
	date: string | null;
	timeMinutes: number | null;
	recurrence: EventRecurrence | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

function serialize(row: EventRow) {
	return {
		...row,
		completedAt: row.completedAt?.getTime() ?? null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * The model invariants, checked in the router rather than as CHECK constraints
 * so their refusal carries a domain message instead of a bare 500. On PATCH
 * they run against the merged row, so clearing one half of a pair is still
 * checked against the half that stays.
 */
function invalidEvent(row: {
	date: string | null;
	timeMinutes: number | null;
	recurrence: EventRecurrence | null;
	completedAt: number | null;
}) {
	if (row.date === null) {
		if (row.timeMinutes !== null) return 'EVENT_TIME_REQUIRES_DATE' as const;
		if (row.recurrence !== null)
			return 'EVENT_RECURRENCE_REQUIRES_DATE' as const;
	}
	if (row.recurrence !== null && row.completedAt !== null)
		return 'EVENT_COMPLETED_AT_ON_RECURRING' as const;
	if (
		row.recurrence?.until !== undefined &&
		row.date !== null &&
		row.recurrence.until < row.date
	)
		return 'EVENT_RECURRENCE_ENDS_BEFORE_START' as const;
	return undefined;
}

export const eventsRouter = new Elysia({
	prefix: '/events',
	tags: ['Calendar'],
})
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) => {
			// One payload, one tag: completions belong to the same picture the
			// index paints, and a separate endpoint would revalidate them apart
			// from the events they annotate.
			const [events, completions] = await Promise.all([
				db
					.select(eventColumns)
					.from(event)
					.orderBy(event.createdAt, event.id)
					.$withCache(false),
				db
					.select({
						eventId: eventCompletion.eventId,
						date: eventCompletion.date,
						status: eventCompletion.status,
					})
					.from(eventCompletion)
					.orderBy(eventCompletion.eventId, eventCompletion.date)
					.$withCache(false),
			]);

			const payload = { events: events.map(serialize), completions };
			const tag = entityTag(payload);
			set.headers.etag = tag;
			return isUnchanged(request, tag) ? status(304) : payload;
		},
		{ detail: { summary: 'List events and completions' } },
	)
	/**
	 * View state shared across devices — custom day groups and hidden tags.
	 * `null` means the cache has nothing and lets the device seed with its
	 * mirror; `{}` is a value, which is how clearing travels. Declared before
	 * `/:id`, which parses its parameter as a uuid and would answer 422.
	 */
	.get(
		'/settings',
		async () => ({ settings: await calendarSettingsStore.read() }),
		{ detail: { summary: 'Read the shared calendar settings' } },
	)
	.put(
		'/settings',
		async ({ body }) => {
			// A cache that is down is reported as a failure to store, not as a 500:
			// the device keeps its own mirror either way.
			const stored = await calendarSettingsStore.write(body);
			if (!stored)
				return status(503, { error: 'CALENDAR_SETTINGS_UNAVAILABLE' });
			return { settings: body };
		},
		{
			body: calendarSettingsSchema,
			detail: { summary: 'Replace the shared calendar settings' },
		},
	)
	.post(
		'/',
		async ({ body }) => {
			const invalid = invalidEvent({
				date: body.date,
				timeMinutes: body.timeMinutes,
				recurrence: body.recurrence,
				completedAt: body.completedAt,
			});
			if (invalid) return status(422, { error: invalid });

			const createdAt = new Date(body.createdAt ?? Date.now());

			// The id comes from the client so an event created offline exists
			// before the server hears of it, and so the outbox can retry a create
			// whose response was lost: the second attempt lands here, inserts
			// nothing, and answers with the row the first attempt made.
			const [created] = await db
				.insert(event)
				.values({
					id: body.id,
					title: body.title,
					details: body.details,
					tag: body.tag,
					date: body.date,
					timeMinutes: body.timeMinutes,
					recurrence: body.recurrence,
					completedAt:
						body.completedAt === null ? null : new Date(body.completedAt),
					createdAt,
					updatedAt: createdAt,
				})
				.onConflictDoNothing({ target: event.id })
				.returning(eventColumns);

			if (created) return status(201, serialize(created));

			const [existing] = await db
				.select(eventColumns)
				.from(event)
				.where(eq(event.id, body.id))
				.limit(1)
				.$withCache(false);

			if (!existing) throw new Error('Insert returned no row');
			return serialize(existing);
		},
		{
			body: z.object({
				id: eventId,
				title: eventTitle,
				details: eventDetails.default(null),
				tag: eventTag.default(null),
				date: localDate.nullable().default(null),
				timeMinutes: timeMinutes.nullable().default(null),
				recurrence: recurrence.nullable().default(null),
				completedAt: timestampMs.nullable().default(null),
				createdAt: timestampMs.optional(),
			}),
			detail: { summary: 'Create an event' },
		},
	)
	.patch(
		'/:id',
		async ({ body, params }) => {
			const [current] = await db
				.select(eventColumns)
				.from(event)
				.where(eq(event.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!current) return status(404, { error: 'EVENT_NOT_FOUND' });

			// Last write wins on the client's edit clock, not on arrival order:
			// two devices editing offline converge on the newer edit no matter
			// which sync runs first. A stale patch is answered with the stored row
			// for the sender to adopt.
			if (current.updatedAt.getTime() >= body.updatedAt)
				return serialize(current);

			const merged = {
				date: body.date === undefined ? current.date : body.date,
				timeMinutes:
					body.timeMinutes === undefined
						? current.timeMinutes
						: body.timeMinutes,
				recurrence:
					body.recurrence === undefined ? current.recurrence : body.recurrence,
				completedAt:
					body.completedAt === undefined
						? (current.completedAt?.getTime() ?? null)
						: body.completedAt,
			};
			const invalid = invalidEvent(merged);
			if (invalid) return status(422, { error: invalid });

			const [updated] = await db
				.update(event)
				.set({
					title: body.title,
					details: body.details,
					tag: body.tag,
					date: body.date,
					timeMinutes: body.timeMinutes,
					recurrence: body.recurrence,
					completedAt:
						body.completedAt === undefined
							? undefined
							: body.completedAt === null
								? null
								: new Date(body.completedAt),
					updatedAt: new Date(body.updatedAt),
				})
				.where(eq(event.id, params.id))
				.returning(eventColumns);

			if (!updated) return status(404, { error: 'EVENT_NOT_FOUND' });
			return serialize(updated);
		},
		{
			params: z.object({ id: eventId }),
			body: z.object({
				updatedAt: timestampMs,
				title: eventTitle.optional(),
				details: eventDetails.optional(),
				tag: eventTag.optional(),
				date: localDate.nullable().optional(),
				timeMinutes: timeMinutes.nullable().optional(),
				recurrence: recurrence.nullable().optional(),
				completedAt: timestampMs.nullable().optional(),
			}),
			detail: { summary: 'Update an event' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			await db.delete(event).where(eq(event.id, params.id));
			return status(204);
		},
		{
			params: z.object({ id: eventId }),
			detail: { summary: 'Delete an event' },
		},
	)
	.put(
		'/:id/completions/:date',
		async ({ body, params }) => {
			const [owner] = await db
				.select({ recurrence: event.recurrence })
				.from(event)
				.where(eq(event.id, params.id))
				.limit(1)
				.$withCache(false);

			if (!owner) return status(404, { error: 'EVENT_NOT_FOUND' });
			// A one-off's done mark lives on the row itself; letting it also have
			// completions would give the same fact two homes that can disagree.
			if (!owner.recurrence)
				return status(422, { error: 'EVENT_NOT_RECURRING' });

			const [stored] = await db
				.insert(eventCompletion)
				.values({
					eventId: params.id,
					date: params.date,
					status: body.status,
				})
				.onConflictDoUpdate({
					target: [eventCompletion.eventId, eventCompletion.date],
					set: { status: body.status },
				})
				.returning({
					eventId: eventCompletion.eventId,
					date: eventCompletion.date,
					status: eventCompletion.status,
				});

			if (!stored) throw new Error('Upsert returned no row');
			return stored;
		},
		{
			params: z.object({ id: eventId, date: localDate }),
			// 'done' is the only status left: skipping died as a concept.
			body: z.object({ status: z.enum(['done']) }),
			detail: { summary: 'Resolve an occurrence' },
		},
	)
	.delete(
		'/:id/completions/:date',
		async ({ params }) => {
			await db
				.delete(eventCompletion)
				.where(
					and(
						eq(eventCompletion.eventId, params.id),
						eq(eventCompletion.date, params.date),
					),
				);
			return status(204);
		},
		{
			params: z.object({ id: eventId, date: localDate }),
			detail: { summary: 'Reopen an occurrence' },
		},
	);
