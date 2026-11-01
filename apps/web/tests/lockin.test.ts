import {
	challengeProgress,
	challengeWeeks,
	dayAccess,
	dayVerdicts,
	formatSleep,
	kpiStreaks,
	kpiTallies,
	lockinMisses,
	nextDayToLog,
	parseCount,
	parseSleep,
	parseWeight,
	weekReport,
	weightRatePerWeek,
	weightTrend,
} from '@web/lib/lockin';
import type { LockinDay } from '@web/lib/lockin-api';
import { lockinSummaryRows } from '@web/lib/lockin-system';
import { describe, expect, it } from 'vitest';

const WINDOW = { from: '2026-11-01', to: '2026-12-05' };

/** Every answer on target, for a weekday. */
function dayOf(date: string, overrides: Partial<LockinDay> = {}): LockinDay {
	return {
		date,
		calories: 2400,
		proteinGrams: 190,
		masturbated: false,
		mateAndSupplements: true,
		gym: new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? null : 'push',
		steps: 15_000,
		weightKg: 82,
		sleepMinutes: 480,
		...overrides,
	};
}

const logOf = (...days: LockinDay[]) =>
	new Map(days.map((day) => [day.date, day]));

/** Days from 1 November, one per argument, each with its overrides. */
const novemberOf = (...overrides: Array<Partial<LockinDay>>) =>
	logOf(
		...overrides.map((override, index) =>
			dayOf(`2026-11-${String(index + 1).padStart(2, '0')}`, override),
		),
	);

describe('lock-in weeks', () => {
	it('splits the window into five Sunday-first weeks', () => {
		const weeks = challengeWeeks(WINDOW);

		expect(weeks).toHaveLength(5);
		expect(weeks[0]?.[0]).toBe('2026-11-01');
		expect(weeks[0]?.[6]).toBe('2026-11-07');
		expect(weeks[4]?.[0]).toBe('2026-11-29');
		expect(weeks[4]?.[6]).toBe('2026-12-05');
	});

	it('reads the day number off the local date', () => {
		expect(challengeProgress(WINDOW, '2026-10-31')).toEqual({
			phase: 'upcoming',
			day: 0,
			total: 35,
		});
		expect(challengeProgress(WINDOW, '2026-11-12')).toEqual({
			phase: 'running',
			day: 12,
			total: 35,
		});
		expect(challengeProgress(WINDOW, '2026-12-06').phase).toBe('finished');
	});
});

describe('lock-in daily verdicts', () => {
	it('judges each answer against its own target, at the boundary too', () => {
		const verdicts = dayVerdicts(
			'2026-11-02',
			dayOf('2026-11-02', {
				calories: 4000,
				proteinGrams: 179,
				steps: 14_000,
				sleepMinutes: 449,
				masturbated: true,
				mateAndSupplements: false,
				gym: 'skipped',
			}),
		);

		expect(verdicts).toEqual({
			calories: 'met',
			protein: 'missed',
			steps: 'met',
			sleep: 'missed',
			clean: 'missed',
			mate: 'missed',
			gym: 'missed',
		});
	});

	it('leaves an unanswered field pending, and Sunday a rest day for the gym', () => {
		const verdicts = dayVerdicts(
			'2026-11-01',
			dayOf('2026-11-01', { calories: null }),
		);

		expect(verdicts.calories).toBe('pending');
		expect(verdicts.gym).toBe('rest');
		expect(Object.values(dayVerdicts('2026-11-02', undefined))).toEqual(
			Array(7).fill('pending'),
		);
	});
});

describe('lock-in weekly verdicts', () => {
	const week = challengeWeeks(WINDOW)[0] ?? [];

	it('misses the week as soon as the calories pass the budget', () => {
		const log = novemberOf(
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 1300 },
		);

		expect(weekReport(week, log).calories).toEqual({
			total: 16_900,
			verdict: 'missed',
		});
	});

	it('meets the calories only once every day of the week is in', () => {
		const partial = novemberOf({}, {}, {});
		expect(weekReport(week, partial).calories.verdict).toBe('pending');

		const whole = novemberOf({}, {}, {}, {}, {}, {}, {});
		expect(weekReport(week, whole).calories).toEqual({
			total: 16_800,
			verdict: 'met',
		});
	});

	it('wants two pushes, two pulls and a legs-core day, and says what is left', () => {
		const met = novemberOf(
			{},
			{ gym: 'push' },
			{ gym: 'pull' },
			{ gym: 'legs-core' },
			{ gym: 'push' },
			{ gym: 'pull' },
			{ gym: 'cardio' },
		);
		expect(weekReport(week, met).gym.verdict).toBe('met');

		const going = novemberOf({}, { gym: 'push' }, { gym: 'push' });
		expect(weekReport(week, going).gym).toMatchObject({
			verdict: 'pending',
			needed: { push: 0, pull: 2, 'legs-core': 1 },
		});

		// Four days left and four sessions still owed: still possible.
		const tight = novemberOf({}, { gym: 'cardio' }, { gym: 'push' });
		expect(weekReport(week, tight).gym.verdict).toBe('pending');

		// Three days left, four sessions owed: already lost.
		const lost = novemberOf(
			{},
			{ gym: 'cardio' },
			{ gym: 'skipped' },
			{ gym: 'push' },
		);
		expect(weekReport(week, lost).gym.verdict).toBe('missed');
	});
});

describe('lock-in streaks', () => {
	it('counts each KPI on its own, through today', () => {
		const log = novemberOf({}, { proteinGrams: 100 }, {}, { steps: 2000 }, {});

		const streaks = kpiStreaks(WINDOW, log, '2026-11-05');

		expect(streaks.protein).toEqual({ current: 3, best: 3 });
		expect(streaks.steps).toEqual({ current: 1, best: 3 });
		expect(streaks.calories).toEqual({ current: 5, best: 5 });
	});

	it('lets the rest day pass without adding to the gym streak or breaking it', () => {
		const log = novemberOf({}, {}, {});

		expect(kpiStreaks(WINDOW, log, '2026-11-03').gym).toEqual({
			current: 2,
			best: 2,
		});
	});

	it('does not break a streak over today still being open, but does over a day left behind', () => {
		const log = novemberOf({}, {});

		expect(kpiStreaks(WINDOW, log, '2026-11-03').protein.current).toBe(2);
		expect(kpiStreaks(WINDOW, log, '2026-11-04').protein).toEqual({
			current: 0,
			best: 2,
		});
	});

	it('counts a day logged ahead of time, and leaves an unanswered future field alone', () => {
		const log = novemberOf({}, {}, {}, { proteinGrams: null });

		const streaks = kpiStreaks(WINDOW, log, '2026-11-02');
		expect(streaks.protein).toEqual({ current: 3, best: 3 });
		expect(streaks.calories).toEqual({ current: 4, best: 4 });
		expect(kpiTallies(WINDOW, log, '2026-11-02').calories.met).toBe(4);
	});

	it('tallies the days judged so far, not the ones still open', () => {
		const log = novemberOf({}, { calories: 4500 }, { calories: null });

		expect(kpiTallies(WINDOW, log, '2026-11-03').calories).toEqual({
			met: 1,
			missed: 1,
		});
	});
});

describe('lock-in logging order', () => {
	it('opens a day once the one before is complete, past or future alike', () => {
		const log = novemberOf({}, { steps: null });

		expect(dayAccess('2026-11-02', WINDOW, log)).toBe('open');
		expect(dayAccess('2026-11-03', WINDOW, log)).toBe('locked');
		expect(dayAccess('2026-11-01', WINDOW, new Map())).toBe('open');
		// Nothing about today: a whole logged week opens the next Sunday.
		expect(
			dayAccess('2026-11-08', WINDOW, novemberOf({}, {}, {}, {}, {}, {}, {})),
		).toBe('open');
	});

	it('points at the first day that is not complete yet', () => {
		expect(nextDayToLog(WINDOW, novemberOf({}, {}), '2026-11-05')).toBe(
			'2026-11-03',
		);
		expect(
			nextDayToLog(
				WINDOW,
				novemberOf({}, { sleepMinutes: null }),
				'2026-11-05',
			),
		).toBe('2026-11-02');
		expect(nextDayToLog(WINDOW, novemberOf({}, {}), '2026-11-02')).toBe(
			undefined,
		);
		expect(nextDayToLog(WINDOW, new Map(), '2026-10-31')).toBe(undefined);
	});
});

describe('lock-in sleep', () => {
	it('reads hours and minutes the way they get typed', () => {
		expect(parseSleep('7:30')).toBe(450);
		expect(parseSleep('07:05')).toBe(425);
		expect(parseSleep('8')).toBe(480);
		expect(parseSleep('6h45')).toBe(405);
		expect(parseSleep('7:60')).toBe(undefined);
		expect(parseSleep('25:00')).toBe(undefined);
		expect(parseSleep('')).toBe(undefined);
	});

	it('writes minutes back as H:MM', () => {
		expect(formatSleep(450)).toBe('7:30');
		expect(formatSleep(425)).toBe('7:05');
	});
});

describe('lock-in form numbers', () => {
	it('reads whole counts with either thousands separator', () => {
		expect(parseCount('15.000')).toBe(15_000);
		expect(parseCount('15,000')).toBe(15_000);
		expect(parseCount(' 2400 ')).toBe(2400);
		expect(parseCount('')).toBe(null);
		expect(parseCount('12a')).toBe(undefined);
	});

	it('reads the weight with a comma or a dot, within what a body weighs', () => {
		expect(parseWeight('82,4')).toBe(82.4);
		expect(parseWeight('82.45')).toBe(82.45);
		expect(parseWeight('')).toBe(null);
		expect(parseWeight('8')).toBe(undefined);
		expect(parseWeight('1.234,5')).toBe(undefined);
	});
});

describe('lock-in weight and misses', () => {
	it('smooths the weight over the trailing week of logged days', () => {
		const log = novemberOf(
			{ weightKg: 84 },
			{ weightKg: 83 },
			{ weightKg: null },
			{ weightKg: 82 },
		);

		const trend = weightTrend(WINDOW, log, '2026-11-04');

		expect(trend.map((point) => point.kg)).toEqual([84, 83, null, 82]);
		expect(trend.map((point) => point.average)).toEqual([84, 83.5, 83.5, 83]);
	});

	it('reads the weekly rate off a straight line through the weigh-ins', () => {
		const log = novemberOf(
			{ weightKg: 84 },
			{ weightKg: 84.2 },
			{ weightKg: 83.6 },
			{ weightKg: 83.7 },
			{ weightKg: 83.2 },
			{ weightKg: 83.4 },
			{ weightKg: 82.9 },
		);

		// The least-squares slope is −0.189 kg a day under the noise: −1.3 a week.
		expect(weightRatePerWeek(weightTrend(WINDOW, log, '2026-11-07'))).toBe(
			-1.3,
		);
		expect(
			weightRatePerWeek(
				weightTrend(WINDOW, novemberOf({ weightKg: 84 }), '2026-11-01'),
			),
		).toBe(undefined);
	});

	it('lists what went wrong, newest first, with how far off it was', () => {
		const log = novemberOf({ calories: 4350 }, { proteinGrams: 150 });

		expect(lockinMisses(WINDOW, log, '2026-11-02')).toEqual([
			{ date: '2026-11-02', kpi: 'protein', detail: '150 g · 30 short' },
			{ date: '2026-11-01', kpi: 'calories', detail: '4,350 kcal · 350 over' },
		]);
	});
});

describe('lock-in sidebar summary', () => {
	it('says nothing before the log has loaded', () => {
		expect(lockinSummaryRows(undefined, new Map(), '2026-11-03')).toEqual([]);
	});

	it('says which day it is, what is waiting to be logged and the week budget left', () => {
		const rows = lockinSummaryRows(
			WINDOW,
			novemberOf({ calories: 3000 }, { calories: 2000 }),
			'2026-11-04',
		);

		expect(rows).toEqual([
			{ key: 'day', label: 'Day', detail: '4 / 35' },
			{ key: 'log', label: 'To log', detail: 'Tue 3 Nov', to: '/lockin?new=1' },
			{ key: 'kcal', label: 'Kcal left this week', detail: '11,800' },
		]);
	});

	it('says how far over the week went rather than a negative budget', () => {
		const rows = lockinSummaryRows(
			WINDOW,
			novemberOf({ calories: 9000 }, { calories: 8000 }),
			'2026-11-02',
		);

		expect(rows.find((row) => row.key === 'kcal')).toEqual({
			key: 'kcal',
			label: 'Kcal this week',
			detail: '200 over',
		});
	});
});
