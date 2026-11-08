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
	shiftDate,
	weekReport,
	weightRatePerWeek,
	weightTrend,
} from '@web/lib/lockin';
import type { LockinDay } from '@web/lib/lockin-api';
import { lockinSummaryRows } from '@web/lib/lockin-system';
import { describe, expect, it } from 'vitest';

/** Monday 9 November through Tuesday 8 December: thirty days. */
const WINDOW = { from: '2026-11-09', to: '2026-12-08' };

/** Every answer on target; Sunday has no gym to answer. */
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

/** Days from Monday 9 November, one per argument, each with its overrides. */
const challengeOf = (...overrides: Array<Partial<LockinDay>>) =>
	logOf(
		...overrides.map((override, index) =>
			dayOf(shiftDate(WINDOW.from, index), override),
		),
	);

describe('lock-in weeks', () => {
	it('splits the window into Monday-first weeks, the last one two days long', () => {
		const weeks = challengeWeeks(WINDOW);

		expect(weeks).toHaveLength(5);
		expect(weeks[0]?.[0]).toBe('2026-11-09');
		expect(weeks[0]?.[6]).toBe('2026-11-15');
		expect(weeks[3]?.[0]).toBe('2026-11-30');
		expect(weeks[3]?.[6]).toBe('2026-12-06');
		expect(weeks[4]).toEqual(['2026-12-07', '2026-12-08']);
	});

	it('reads the day number off the local date', () => {
		expect(challengeProgress(WINDOW, '2026-11-08')).toEqual({
			phase: 'upcoming',
			day: 0,
			total: 30,
		});
		expect(challengeProgress(WINDOW, '2026-11-20')).toEqual({
			phase: 'running',
			day: 12,
			total: 30,
		});
		expect(challengeProgress(WINDOW, '2026-12-09').phase).toBe('finished');
	});
});

describe('lock-in daily verdicts', () => {
	it('judges each answer against its own target, at the boundary too', () => {
		const verdicts = dayVerdicts(
			'2026-11-10',
			dayOf('2026-11-10', {
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
			'2026-11-15',
			dayOf('2026-11-15', { calories: null }),
		);

		expect(verdicts.calories).toBe('pending');
		expect(verdicts.gym).toBe('rest');
		expect(Object.values(dayVerdicts('2026-11-10', undefined))).toEqual(
			Array(7).fill('pending'),
		);
	});
});

describe('lock-in weekly verdicts', () => {
	const week = challengeWeeks(WINDOW)[0] ?? [];

	it('misses the week as soon as the calories pass the budget', () => {
		const log = challengeOf(
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 3900 },
			{ calories: 3900 },
		);

		expect(weekReport(week, log).calories).toEqual({
			total: 19_500,
			verdict: 'missed',
		});
	});

	it('meets the calories only once every day of the week is in', () => {
		const partial = challengeOf({}, {}, {});
		expect(weekReport(week, partial).calories.verdict).toBe('pending');

		const pace = { calories: 2700 };
		const whole = challengeOf(pace, pace, pace, pace, pace, pace, pace);
		expect(weekReport(week, whole).calories).toEqual({
			total: 18_900,
			verdict: 'met',
		});
	});

	it('wants two pushes, two pulls and a legs-core day, and says what is left', () => {
		const met = challengeOf(
			{ gym: 'push' },
			{ gym: 'pull' },
			{ gym: 'legs-core' },
			{ gym: 'push' },
			{ gym: 'pull' },
			{ gym: 'cardio' },
			{},
		);
		expect(weekReport(week, met).gym.verdict).toBe('met');

		const going = challengeOf({ gym: 'push' }, { gym: 'push' });
		expect(weekReport(week, going).gym).toMatchObject({
			verdict: 'pending',
			needed: { push: 0, pull: 2, 'legs-core': 1 },
		});

		// Four weekdays left and four sessions still owed: still possible.
		const tight = challengeOf({ gym: 'cardio' }, { gym: 'push' });
		expect(weekReport(week, tight).gym.verdict).toBe('pending');

		// Three weekdays left, four sessions owed: already lost.
		const lost = challengeOf(
			{ gym: 'cardio' },
			{ gym: 'skipped' },
			{ gym: 'push' },
		);
		expect(weekReport(week, lost).gym.verdict).toBe('missed');
	});

	it('judges no weekly rule on the two-day tail', () => {
		const tail = challengeWeeks(WINDOW)[4] ?? [];
		const log = logOf(
			dayOf('2026-12-07', { calories: 9000, gym: 'skipped' }),
			dayOf('2026-12-08', { calories: 9000, gym: 'skipped' }),
		);

		const report = weekReport(tail, log);

		expect(report.judged).toBe(false);
		expect(report.calories).toEqual({ total: 18_000, verdict: 'rest' });
		expect(report.gym.verdict).toBe('rest');
		expect(weekReport(week, challengeOf({})).judged).toBe(true);
	});
});

describe('lock-in streaks', () => {
	it('counts each KPI on its own, through today', () => {
		const log = challengeOf({}, { proteinGrams: 100 }, {}, { steps: 2000 }, {});

		const streaks = kpiStreaks(WINDOW, log, '2026-11-13');

		expect(streaks.protein).toEqual({ current: 3, best: 3 });
		expect(streaks.steps).toEqual({ current: 1, best: 3 });
		expect(streaks.calories).toEqual({ current: 5, best: 5 });
	});

	it('lets the rest day pass without adding to the gym streak or breaking it', () => {
		// Monday to Saturday, the Sunday off, and Monday again.
		const log = challengeOf({}, {}, {}, {}, {}, {}, {}, {});

		expect(kpiStreaks(WINDOW, log, '2026-11-16').gym).toEqual({
			current: 7,
			best: 7,
		});
	});

	it('does not break a streak over today still being open, but does over a day left behind', () => {
		const log = challengeOf({}, {});

		expect(kpiStreaks(WINDOW, log, '2026-11-11').protein.current).toBe(2);
		expect(kpiStreaks(WINDOW, log, '2026-11-12').protein).toEqual({
			current: 0,
			best: 2,
		});
	});

	it('counts a day logged ahead of time, and leaves an unanswered future field alone', () => {
		const log = challengeOf({}, {}, {}, { proteinGrams: null });

		const streaks = kpiStreaks(WINDOW, log, '2026-11-10');
		expect(streaks.protein).toEqual({ current: 3, best: 3 });
		expect(streaks.calories).toEqual({ current: 4, best: 4 });
		expect(kpiTallies(WINDOW, log, '2026-11-10').calories.met).toBe(4);
	});

	it('tallies the days judged so far, not the ones still open', () => {
		const log = challengeOf({}, { calories: 4500 }, { calories: null });

		expect(kpiTallies(WINDOW, log, '2026-11-11').calories).toEqual({
			met: 1,
			missed: 1,
		});
	});
});

describe('lock-in logging order', () => {
	it('opens a day once the one before is complete, past or future alike', () => {
		const log = challengeOf({}, { steps: null });

		expect(dayAccess('2026-11-10', WINDOW, log)).toBe('open');
		expect(dayAccess('2026-11-11', WINDOW, log)).toBe('locked');
		expect(dayAccess('2026-11-09', WINDOW, new Map())).toBe('open');
		// Nothing about today: a whole logged week opens the next Monday.
		expect(
			dayAccess('2026-11-16', WINDOW, challengeOf({}, {}, {}, {}, {}, {}, {})),
		).toBe('open');
	});

	it('points at the first day that is not complete yet', () => {
		expect(nextDayToLog(WINDOW, challengeOf({}, {}), '2026-11-13')).toBe(
			'2026-11-11',
		);
		expect(
			nextDayToLog(
				WINDOW,
				challengeOf({}, { sleepMinutes: null }),
				'2026-11-13',
			),
		).toBe('2026-11-10');
		expect(nextDayToLog(WINDOW, challengeOf({}, {}), '2026-11-10')).toBe(
			undefined,
		);
		expect(nextDayToLog(WINDOW, new Map(), '2026-11-08')).toBe(undefined);
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
		const log = challengeOf(
			{ weightKg: 84 },
			{ weightKg: 83 },
			{ weightKg: null },
			{ weightKg: 82 },
		);

		const trend = weightTrend(WINDOW, log, '2026-11-12');

		expect(trend.map((point) => point.kg)).toEqual([84, 83, null, 82]);
		expect(trend.map((point) => point.average)).toEqual([84, 83.5, 83.5, 83]);
	});

	it('reads the weekly rate off a straight line through the weigh-ins', () => {
		const log = challengeOf(
			{ weightKg: 84 },
			{ weightKg: 84.2 },
			{ weightKg: 83.6 },
			{ weightKg: 83.7 },
			{ weightKg: 83.2 },
			{ weightKg: 83.4 },
			{ weightKg: 82.9 },
		);

		// The least-squares slope is −0.189 kg a day under the noise: −1.3 a week.
		expect(weightRatePerWeek(weightTrend(WINDOW, log, '2026-11-15'))).toBe(
			-1.3,
		);
		expect(
			weightRatePerWeek(
				weightTrend(WINDOW, challengeOf({ weightKg: 84 }), '2026-11-09'),
			),
		).toBe(undefined);
	});

	it('lists what went wrong, newest first, with how far off it was', () => {
		const log = challengeOf({ calories: 4350 }, { proteinGrams: 150 });

		expect(lockinMisses(WINDOW, log, '2026-11-10')).toEqual([
			{ date: '2026-11-10', kpi: 'protein', detail: '150 g · 30 short' },
			{ date: '2026-11-09', kpi: 'calories', detail: '4,350 kcal · 350 over' },
		]);
	});

	it('lists only daily misses on the tail, where no weekly rule applies', () => {
		const log = logOf(
			dayOf('2026-12-07', { gym: 'skipped' }),
			dayOf('2026-12-08', { gym: 'skipped' }),
		);

		expect(lockinMisses(WINDOW, log, '2026-12-08')).toEqual([
			{ date: '2026-12-08', kpi: 'gym', detail: 'No session' },
			{ date: '2026-12-07', kpi: 'gym', detail: 'No session' },
		]);
	});
});

describe('lock-in sidebar summary', () => {
	it('says nothing before the log has loaded', () => {
		expect(lockinSummaryRows(undefined, new Map(), '2026-11-11')).toEqual([]);
	});

	it('says which day it is, what is waiting to be logged and the week budget left', () => {
		const rows = lockinSummaryRows(
			WINDOW,
			challengeOf({ calories: 3000 }, { calories: 2000 }),
			'2026-11-12',
		);

		expect(rows).toEqual([
			{ key: 'day', label: 'Day', detail: '4 / 30' },
			{
				key: 'log',
				label: 'To log',
				detail: 'Wed 11 Nov',
				to: '/lockin?new=1',
			},
			{ key: 'kcal', label: 'Kcal left this week', detail: '13,900' },
		]);
	});

	it('says how far over the week went rather than a negative budget', () => {
		const rows = lockinSummaryRows(
			WINDOW,
			challengeOf({ calories: 10_000 }, { calories: 9000 }),
			'2026-11-10',
		);

		expect(rows.find((row) => row.key === 'kcal')).toEqual({
			key: 'kcal',
			label: 'Kcal this week',
			detail: '100 over',
		});
	});

	it('has no week budget to report on the tail', () => {
		const rows = lockinSummaryRows(WINDOW, new Map(), '2026-12-07');

		expect(rows.find((row) => row.key === 'day')?.detail).toBe('29 / 30');
		expect(rows.find((row) => row.key === 'kcal')).toBe(undefined);
	});
});
