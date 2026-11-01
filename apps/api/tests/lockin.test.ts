import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	setSystemTime,
} from 'bun:test';
import { cache, db } from '@api/env';
import { indexTagKey } from '@api/http-cache';
import { lockinDay } from '@api/schema';
import { json, request } from './helpers';

type DayBody = {
	date: string;
	calories: number | null;
	proteinGrams: number | null;
	masturbated: boolean | null;
	mateAndSupplements: boolean | null;
	gym: string | null;
	steps: number | null;
	weightKg: number | null;
	sleepMinutes: number | null;
};

/** Every field answered, for a weekday. Sunday drops `gym`. */
const COMPLETE = {
	calories: 2400,
	proteinGrams: 190,
	masturbated: false,
	mateAndSupplements: true,
	gym: 'push',
	steps: 15_000,
	weightKg: 82.4,
	sleepMinutes: 460,
};

const EMPTY = {
	calories: null,
	proteinGrams: null,
	masturbated: null,
	mateAndSupplements: null,
	gym: null,
	steps: null,
	weightKg: null,
	sleepMinutes: null,
};

const put = (date: string, body: Record<string, unknown>) =>
	json(`/lockin/${date}`, 'PUT', body);

/** Logs 1 November (a Sunday, so no gym) through `last`, each one complete. */
async function logThrough(last: string) {
	for (
		let date = new Date('2026-11-01T00:00:00Z');
		date.toISOString().slice(0, 10) <= last;
		date.setUTCDate(date.getUTCDate() + 1)
	) {
		const iso = date.toISOString().slice(0, 10);
		const response = await put(iso, {
			...COMPLETE,
			gym: date.getUTCDay() === 0 ? null : 'push',
		});
		expect(response.status).toBe(200);
	}
}

/**
 * The challenge window is fixed, so these tests write the very dates a real
 * log lives on, in a database `.env` shares. Whatever was there is put back.
 */
let held: (typeof lockinDay.$inferSelect)[] = [];

beforeAll(async () => {
	held = await db.select().from(lockinDay);
	await db.delete(lockinDay);
});

afterEach(async () => {
	await db.delete(lockinDay);
	setSystemTime();
});

afterAll(async () => {
	setSystemTime();
	if (held.length > 0) await db.insert(lockinDay).values(held);
	await cache.del(indexTagKey('lockin'));
});

describe('lock-in', () => {
	it('lists the window and the logged days in order', async () => {
		await logThrough('2026-11-02');

		const response = await request('/lockin');
		const body = (await response.json()) as {
			from: string;
			to: string;
			days: DayBody[];
		};

		expect(response.status).toBe(200);
		expect(body.from).toBe('2026-11-01');
		expect(body.to).toBe('2026-12-05');
		expect(body.days.map((day) => day.date)).toEqual([
			'2026-11-01',
			'2026-11-02',
		]);
		expect(body.days[1]).toMatchObject({ ...COMPLETE, date: '2026-11-02' });
	});

	it('keeps a partly answered day, and serves the change past a held tag', async () => {
		const before = await request('/lockin');
		const tag = before.headers.get('etag') ?? '';

		const saved = await put('2026-11-01', { ...EMPTY, weightKg: 83.15 });
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			date: '2026-11-01',
			weightKg: 83.15,
			calories: null,
		});

		const after = await request('/lockin', {
			headers: { 'if-none-match': tag },
		});
		expect(after.status).toBe(200);
		const body = (await after.json()) as { days: DayBody[] };
		expect(body.days).toHaveLength(1);
	});

	it('refuses a day outside the five weeks', async () => {
		for (const date of ['2026-10-31', '2026-12-06']) {
			const response = await put(date, EMPTY);
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({ error: 'LOCKIN_OUTSIDE_WINDOW' });
		}
	});

	it('takes a day that has not happened yet, once the one before is complete', async () => {
		// Before the challenge even starts: the order is the only gate.
		setSystemTime(new Date('2026-10-20T12:00:00Z'));
		await logThrough('2026-11-03');

		expect((await put('2026-11-04', COMPLETE)).status).toBe(200);
		const skipped = await put('2026-11-06', COMPLETE);
		expect(skipped.status).toBe(409);
		expect(await skipped.json()).toEqual({
			error: 'LOCKIN_PREVIOUS_DAY_INCOMPLETE',
		});
	});

	it('keeps Sunday a rest day', async () => {
		const session = await put('2026-11-01', { ...COMPLETE, gym: 'cardio' });
		expect(session.status).toBe(422);
		expect(await session.json()).toEqual({ error: 'LOCKIN_SUNDAY_IS_REST' });

		// With no gym to answer, Sunday is complete and the week can go on.
		expect((await put('2026-11-01', { ...COMPLETE, gym: null })).status).toBe(
			200,
		);
		expect((await put('2026-11-02', COMPLETE)).status).toBe(200);
	});

	it('requires a weekday to say whether there was a session', async () => {
		await logThrough('2026-11-01');
		expect((await put('2026-11-02', { ...COMPLETE, gym: null })).status).toBe(
			200,
		);

		const response = await put('2026-11-03', COMPLETE);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'LOCKIN_PREVIOUS_DAY_INCOMPLETE',
		});
	});

	it('logs days in order: each one only once the one before is complete', async () => {
		const skipped = await put('2026-11-02', COMPLETE);
		expect(skipped.status).toBe(409);
		expect(await skipped.json()).toEqual({
			error: 'LOCKIN_PREVIOUS_DAY_INCOMPLETE',
		});

		await put('2026-11-01', { ...EMPTY, weightKg: 83 });
		const halfway = await put('2026-11-02', COMPLETE);
		expect(halfway.status).toBe(409);

		await put('2026-11-01', { ...COMPLETE, gym: null });
		expect((await put('2026-11-02', COMPLETE)).status).toBe(200);
	});

	it('will not reopen a day once the next one is logged', async () => {
		await logThrough('2026-11-02');

		const cleared = await put('2026-11-01', {
			...COMPLETE,
			gym: null,
			steps: null,
		});
		expect(cleared.status).toBe(409);
		expect(await cleared.json()).toEqual({ error: 'LOCKIN_LATER_DAY_LOGGED' });

		// Correcting a value is still fine, as long as the day stays complete.
		const corrected = await put('2026-11-01', {
			...COMPLETE,
			gym: null,
			steps: 9_000,
		});
		expect(corrected.status).toBe(200);
		expect(await corrected.json()).toMatchObject({ steps: 9_000 });
	});

	it('bounds every number, not just its type', async () => {
		for (const body of [
			{ ...EMPTY, calories: -1 },
			{ ...EMPTY, steps: 1.5 },
			{ ...EMPTY, sleepMinutes: 24 * 60 + 1 },
			{ ...EMPTY, weightKg: 0 },
			{ ...EMPTY, gym: 'chest' },
		]) {
			const response = await put('2026-11-01', body);
			expect(response.status).toBe(422);
		}
	});
});
