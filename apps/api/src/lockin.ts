import { authPlugin } from '@api/auth';
import { localDate } from '@api/calendar-settings';
import { db } from '@api/env';
import { createIndexCache } from '@api/http-cache';
import { LOCKIN_GYM_SESSIONS, lockinDay } from '@api/schema';
import { asc, between, inArray } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

/**
 * Sunday 1 November through Saturday 5 December 2026: five whole weeks, each
 * opening on its rest day. Sent with the index so the client never keeps a
 * second copy of the dates it has to agree with.
 */
export const LOCKIN_WINDOW: { from: string; to: string } = {
	from: '2026-11-01',
	to: '2026-12-05',
};

/** Counts are whole and bounded well past anything a real day reaches. */
const count = (max: number) =>
	z.number().int().nonnegative().max(max).nullable();

const dayBody = z.object({
	calories: count(20_000),
	proteinGrams: count(1_000),
	masturbated: z.boolean().nullable(),
	mateAndSupplements: z.boolean().nullable(),
	gym: z.enum(LOCKIN_GYM_SESSIONS).nullable(),
	steps: count(200_000),
	// What `numeric(5, 2)` holds; a third decimal is a slip, rounded not refused.
	weightKg: z
		.number()
		.min(20)
		.max(400)
		.transform((value) => Math.round(value * 100) / 100)
		.nullable(),
	sleepMinutes: count(24 * 60),
});

type DayFields = z.infer<typeof dayBody>;

const dayColumns = {
	date: lockinDay.date,
	calories: lockinDay.calories,
	proteinGrams: lockinDay.proteinGrams,
	masturbated: lockinDay.masturbated,
	mateAndSupplements: lockinDay.mateAndSupplements,
	gym: lockinDay.gym,
	steps: lockinDay.steps,
	weightKg: lockinDay.weightKg,
	sleepMinutes: lockinDay.sleepMinutes,
};

function shiftDate(date: string, days: number) {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days))
		.toISOString()
		.slice(0, 10);
}

const isSunday = (date: string) =>
	new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** Every answer given. Sunday has no gym question: it is the rest day. */
function isComplete(date: string, day: DayFields) {
	return (
		day.calories !== null &&
		day.proteinGrams !== null &&
		day.masturbated !== null &&
		day.mateAndSupplements !== null &&
		day.steps !== null &&
		day.weightKg !== null &&
		day.sleepMinutes !== null &&
		(day.gym !== null || isSunday(date))
	);
}

/** Every handler below that writes `lockin_day` drops it before responding. */
const indexCache = createIndexCache('lockin');

export const lockinRouter = new Elysia({
	prefix: '/lockin',
	tags: ['Lock-in'],
})
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) =>
			indexCache.conditional(request, set, async () => {
				const days = await db
					.select(dayColumns)
					.from(lockinDay)
					.where(between(lockinDay.date, LOCKIN_WINDOW.from, LOCKIN_WINDOW.to))
					.orderBy(asc(lockinDay.date));

				return { ...LOCKIN_WINDOW, days };
			}),
		{ detail: { summary: 'List the logged days of the challenge' } },
	)
	.put(
		'/:date',
		async ({ params, body }) => {
			const { date } = params;
			if (date < LOCKIN_WINDOW.from || date > LOCKIN_WINDOW.to)
				return status(422, { error: 'LOCKIN_OUTSIDE_WINDOW' });
			if (isSunday(date) && body.gym !== null)
				return status(422, { error: 'LOCKIN_SUNDAY_IS_REST' });

			/**
			 * Days are logged in order, so the log has no holes to hide a bad day
			 * in: a day opens once the one before is complete, and closes for
			 * good — values can still be corrected, not cleared — once the next
			 * one exists. That is the only gate: past or future, any day the
			 * order reaches can be logged and edited. The two reads and the write are separate statements; a
			 * race between them needs two saves of adjacent days in the same
			 * instant, which one person filling one form does not produce.
			 */
			const before = shiftDate(date, -1);
			const after = shiftDate(date, 1);
			const neighbours = await db
				.select(dayColumns)
				.from(lockinDay)
				.where(inArray(lockinDay.date, [before, after]));
			const previous = neighbours.find((row) => row.date === before);

			if (
				date > LOCKIN_WINDOW.from &&
				!(previous && isComplete(previous.date, previous))
			)
				return status(409, { error: 'LOCKIN_PREVIOUS_DAY_INCOMPLETE' });
			if (
				neighbours.some((row) => row.date === after) &&
				!isComplete(date, body)
			)
				return status(409, { error: 'LOCKIN_LATER_DAY_LOGGED' });

			const [saved] = await db
				.insert(lockinDay)
				.values({ date, ...body })
				.onConflictDoUpdate({
					target: lockinDay.date,
					set: { ...body, updatedAt: new Date() },
				})
				.returning(dayColumns);
			await indexCache.invalidate();

			if (!saved) throw new Error('Upsert returned no row');
			return saved;
		},
		{
			params: z.object({ date: localDate }),
			/** The whole day every time: an omitted answer would be ambiguous. */
			body: dayBody,
			detail: { summary: 'Save one day of the challenge' },
		},
	);
