import type { LockinDay, LockinWindow } from '@web/lib/lockin-api';

/**
 * The rules of the challenge. They live only here: the API stores answers and
 * guards the logging order, but whether an answer met its target is a reading
 * of the row, and every reading happens on this side.
 */
export const LOCKIN_TARGETS = {
	caloriesPerDay: 4000,
	caloriesPerWeek: 18_900,
	proteinGrams: 180,
	steps: 14_000,
	sleepMinutes: 7 * 60 + 30,
	/** The sixth weekday session is whatever is left over, cardio by default. */
	sessionsPerWeek: { push: 2, pull: 2, 'legs-core': 1 },
} as const;

/** Display order, everywhere a KPI is listed. Weight is tracked, not judged. */
export const KPI_KEYS = [
	'calories',
	'protein',
	'steps',
	'gym',
	'sleep',
	'mate',
	'clean',
] as const;

export type KpiKey = (typeof KPI_KEYS)[number];

export const KPI_LABELS: Record<KpiKey, string> = {
	calories: 'Calories',
	protein: 'Protein',
	steps: 'Steps',
	gym: 'Gym',
	sleep: 'Sleep',
	mate: 'Mate & supps',
	clean: 'No fap',
};

/**
 * `pending` is an answer not given yet, never a failure: a day fills in over
 * time. `rest` is Sunday's gym, which is not a question at all.
 */
export type Verdict = 'met' | 'missed' | 'pending' | 'rest';

export type LockinLog = ReadonlyMap<string, LockinDay>;

export type RequiredSession = keyof typeof LOCKIN_TARGETS.sessionsPerWeek;

export type Streak = { current: number; best: number };

const DAY_MS = 24 * 60 * 60 * 1000;

const numberFormat = new Intl.NumberFormat('en-US');
export const formatCount = (value: number) => numberFormat.format(value);

const dayFormat = new Intl.DateTimeFormat('en-GB', {
	weekday: 'short',
	day: 'numeric',
	month: 'short',
	timeZone: 'UTC',
});

// Dates are local `YYYY-MM-DD` strings; arithmetic happens at UTC midnight,
// where no daylight-saving shift can turn a day into 23 or 25 hours.
const atUtcMidnight = (date: string) => new Date(`${date}T00:00:00Z`);

export function shiftDate(date: string, days: number) {
	const moved = atUtcMidnight(date);
	moved.setUTCDate(moved.getUTCDate() + days);
	return moved.toISOString().slice(0, 10);
}

export const isSunday = (date: string) => atUtcMidnight(date).getUTCDay() === 0;

/** "Tue 3 Nov". */
export const formatDay = (date: string) =>
	dayFormat.format(atUtcMidnight(date)).replace(',', '');

/** Today on this device's calendar, which is the one the log is kept in. */
export function localDateOf(now: Date) {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Builds a value per KPI without a cast, in display order. */
export function perKpi<T>(make: (kpi: KpiKey) => T): Record<KpiKey, T> {
	return {
		calories: make('calories'),
		protein: make('protein'),
		steps: make('steps'),
		gym: make('gym'),
		sleep: make('sleep'),
		mate: make('mate'),
		clean: make('clean'),
	};
}

export function challengeDates(window: LockinWindow) {
	const dates: string[] = [];
	for (let date = window.from; date <= window.to; date = shiftDate(date, 1))
		dates.push(date);
	return dates;
}

/**
 * Monday-first weeks, Sunday last. Split on Mondays rather than counted off in
 * sevens, so a week is a calendar week wherever the window starts or ends: the
 * thirty days from Monday 9 November make four whole weeks and a two-day tail.
 */
export function challengeWeeks(window: LockinWindow) {
	const weeks: string[][] = [];
	for (const date of challengeDates(window)) {
		const current = weeks.at(-1);
		if (!current || atUtcMidnight(date).getUTCDay() === 1) weeks.push([date]);
		else current.push(date);
	}
	return weeks;
}

/** The days that can have been lived so far: the window, cut at today. */
const datesThrough = (window: LockinWindow, today: string) =>
	challengeDates(window).filter((date) => date <= today);

/**
 * The days there is something to read on: everything lived so far, and on
 * past today to the last day logged ahead of time — logging is open in both
 * directions, and an answer given is an answer to count.
 */
function readableDates(window: LockinWindow, log: LockinLog, today: string) {
	let last = today;
	for (const date of log.keys()) if (date > last) last = date;
	return datesThrough(window, last);
}

export function challengeProgress(window: LockinWindow, today: string) {
	const total = challengeDates(window).length;
	if (today < window.from) return { phase: 'upcoming' as const, day: 0, total };
	if (today > window.to)
		return { phase: 'finished' as const, day: total, total };
	const day =
		Math.round(
			(atUtcMidnight(today).getTime() - atUtcMidnight(window.from).getTime()) /
				DAY_MS,
		) + 1;
	return { phase: 'running' as const, day, total };
}

const atLeast = (value: number | null, minimum: number): Verdict =>
	value === null ? 'pending' : value >= minimum ? 'met' : 'missed';

const atMost = (value: number | null, maximum: number): Verdict =>
	value === null ? 'pending' : value <= maximum ? 'met' : 'missed';

const answered = (value: boolean | null, expected: boolean): Verdict =>
	value === null ? 'pending' : value === expected ? 'met' : 'missed';

/** How one day went, KPI by KPI. */
export function dayVerdicts(
	date: string,
	day: LockinDay | undefined,
): Record<KpiKey, Verdict> {
	return {
		calories: atMost(day?.calories ?? null, LOCKIN_TARGETS.caloriesPerDay),
		protein: atLeast(day?.proteinGrams ?? null, LOCKIN_TARGETS.proteinGrams),
		steps: atLeast(day?.steps ?? null, LOCKIN_TARGETS.steps),
		gym: isSunday(date)
			? 'rest'
			: !day?.gym
				? 'pending'
				: day.gym === 'skipped'
					? 'missed'
					: 'met',
		sleep: atLeast(day?.sleepMinutes ?? null, LOCKIN_TARGETS.sleepMinutes),
		mate: answered(day?.mateAndSupplements ?? null, true),
		clean: answered(day?.masturbated ?? null, false),
	};
}

/**
 * Every answer given — the same rule the API enforces on the logging order.
 * Weight counts here even though it is not judged: it is still part of the day.
 */
export function isDayComplete(date: string, day: LockinDay | undefined) {
	return (
		day !== undefined &&
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

/**
 * What can be done with a day: `open` to log or correct, `locked` until the
 * day before is complete. The order is the only gate — past or future alike.
 */
export function dayAccess(date: string, window: LockinWindow, log: LockinLog) {
	const previous = shiftDate(date, -1);
	if (date > window.from && !isDayComplete(previous, log.get(previous)))
		return 'locked' as const;
	return 'open' as const;
}

/** Once the next day is logged, a day can be corrected but not left half-empty. */
export const mustStayComplete = (date: string, log: LockinLog) =>
	log.has(shiftDate(date, 1));

/** The first day lived so far that still has answers missing. */
export function nextDayToLog(
	window: LockinWindow,
	log: LockinLog,
	today: string,
) {
	return datesThrough(window, today).find(
		(date) => !isDayComplete(date, log.get(date)),
	);
}

export type WeekReport = {
	/**
	 * Whether the weekly rules apply at all. Only a whole week holds them: the
	 * two-day tail could neither fit the sessions nor sensibly split the
	 * budget, so it is judged by the daily targets alone, by the user's call.
	 * Its verdicts are `rest` — not a question, like Sunday's gym.
	 */
	judged: boolean;
	calories: { total: number; verdict: Verdict };
	gym: {
		counts: Record<NonNullable<LockinDay['gym']>, number>;
		/** Sessions of each required kind still owed this week. */
		needed: Record<RequiredSession, number>;
		verdict: Verdict;
	};
};

/**
 * The two weekly rules. Each is called as soon as it is settled rather than at
 * the end of the week: past the budget is missed on the day it happens, and so
 * is a gym week that no longer has days enough for the sessions it owes.
 */
export function weekReport(week: string[], log: LockinLog): WeekReport {
	let total = 0;
	let allIn = true;
	let openDays = 0;
	const counts = { push: 0, pull: 0, 'legs-core': 0, cardio: 0, skipped: 0 };

	for (const date of week) {
		const day = log.get(date);
		if (day?.calories === null || day?.calories === undefined) allIn = false;
		else total += day.calories;

		if (isSunday(date)) continue;
		if (day?.gym) counts[day.gym] += 1;
		else openDays += 1;
	}

	const quota = LOCKIN_TARGETS.sessionsPerWeek;
	const needed = {
		push: Math.max(0, quota.push - counts.push),
		pull: Math.max(0, quota.pull - counts.pull),
		'legs-core': Math.max(0, quota['legs-core'] - counts['legs-core']),
	};
	const owed = needed.push + needed.pull + needed['legs-core'];

	if (week.length < 7)
		return {
			judged: false,
			calories: { total, verdict: 'rest' },
			gym: { counts, needed, verdict: 'rest' },
		};

	return {
		judged: true,
		calories: {
			total,
			verdict:
				total > LOCKIN_TARGETS.caloriesPerWeek
					? 'missed'
					: allIn
						? 'met'
						: 'pending',
		},
		gym: {
			counts,
			needed,
			verdict: owed === 0 ? 'met' : owed > openDays ? 'missed' : 'pending',
		},
	};
}

/**
 * Consecutive days on target, per KPI, through today — or through the last
 * day logged ahead of it.
 *
 * An open day from today on does not break anything — it is not over. A day
 * left behind unanswered does, the same as a miss: otherwise not logging would
 * be a way to keep a streak alive. Sunday's gym is neither, and passes through.
 */
export function kpiStreaks(
	window: LockinWindow,
	log: LockinLog,
	today: string,
): Record<KpiKey, Streak> {
	const days = readableDates(window, log, today).map(
		(date) => [date, dayVerdicts(date, log.get(date))] as const,
	);

	return perKpi((kpi) => {
		let current = 0;
		let best = 0;
		for (const [date, verdicts] of days) {
			const verdict = verdicts[kpi];
			if (verdict === 'met') {
				current += 1;
				best = Math.max(best, current);
			} else if (
				verdict === 'missed' ||
				(verdict === 'pending' && date < today)
			)
				current = 0;
		}
		return { current, best };
	});
}

/** Days met and missed so far, per KPI; open days are neither. */
export function kpiTallies(
	window: LockinWindow,
	log: LockinLog,
	today: string,
): Record<KpiKey, { met: number; missed: number }> {
	const verdicts = readableDates(window, log, today).map((date) =>
		dayVerdicts(date, log.get(date)),
	);
	return perKpi((kpi) => ({
		met: verdicts.filter((day) => day[kpi] === 'met').length,
		missed: verdicts.filter((day) => day[kpi] === 'missed').length,
	}));
}

/**
 * The weight on each day so far, and its average over the trailing seven days
 * that have one: a single weigh-in swings with water and salt, the average is
 * the trend underneath.
 */
export function weightTrend(
	window: LockinWindow,
	log: LockinLog,
	today: string,
) {
	const dates = readableDates(window, log, today);
	return dates.map((date, index) => {
		const recent = dates
			.slice(Math.max(0, index - 6), index + 1)
			.map((day) => log.get(day)?.weightKg)
			.filter((kg): kg is number => typeof kg === 'number');
		const average =
			recent.length === 0
				? null
				: Math.round(
						(recent.reduce((sum, kg) => sum + kg, 0) / recent.length) * 100,
					) / 100;
		return { date, kg: log.get(date)?.weightKg ?? null, average };
	});
}

/**
 * Kilograms per week, from the least-squares line through every weigh-in so
 * far: the honest rate, where first-versus-last would swing with whichever two
 * mornings happened to bracket the window. Needs two weigh-ins to be a line.
 */
export function weightRatePerWeek(trend: ReturnType<typeof weightTrend>) {
	const points = trend.flatMap((point, day) =>
		point.kg === null ? [] : [{ day, kg: point.kg }],
	);
	if (points.length < 2) return undefined;

	const meanDay = points.reduce((sum, { day }) => sum + day, 0) / points.length;
	const meanKg = points.reduce((sum, { kg }) => sum + kg, 0) / points.length;
	let covariance = 0;
	let variance = 0;
	for (const { day, kg } of points) {
		covariance += (day - meanDay) * (kg - meanKg);
		variance += (day - meanDay) ** 2;
	}
	return Math.round((covariance / variance) * 7 * 10) / 10;
}

/** "7:30". */
export function formatSleep(minutes: number) {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Hours and minutes as they get typed: `7:30`, `07:05`, `6h45`, `7.30`, `8`. */
export function parseSleep(text: string) {
	const match = /^\s*(\d{1,2})(?:\s*[:h.]\s*(\d{1,2}))?\s*$/i.exec(text);
	if (!match) return undefined;
	const minutes = Number(match[2] ?? 0);
	if (minutes > 59) return undefined;
	const total = Number(match[1]) * 60 + minutes;
	return total <= 24 * 60 ? total : undefined;
}

/**
 * A whole count as typed: `15.000` and `15,000` are both fifteen thousand,
 * since nobody logs a fraction of a step. `null` is a field left empty, and
 * `undefined` one that does not read as a number.
 */
export function parseCount(text: string) {
	const digits = text.trim().replace(/[.,\s]/g, '');
	if (!digits) return null;
	return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/** Kilograms with a comma or a dot, within what a body weighs (the API's bound). */
export function parseWeight(text: string) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (!/^\d{2,3}([.,]\d{1,2})?$/.test(trimmed)) return undefined;
	const kg = Number(trimmed.replace(',', '.'));
	return kg >= 20 && kg <= 400 ? kg : undefined;
}

export type LockinMiss = {
	date: string;
	kpi: KpiKey;
	detail: string;
	/** A weekly rule rather than one day's answer. */
	week?: number;
};

function missDetail(kpi: KpiKey, day: LockinDay) {
	switch (kpi) {
		case 'calories': {
			const value = day.calories ?? 0;
			return `${formatCount(value)} kcal · ${formatCount(value - LOCKIN_TARGETS.caloriesPerDay)} over`;
		}
		case 'protein': {
			const value = day.proteinGrams ?? 0;
			return `${value} g · ${LOCKIN_TARGETS.proteinGrams - value} short`;
		}
		case 'steps': {
			const value = day.steps ?? 0;
			return `${formatCount(value)} · ${formatCount(LOCKIN_TARGETS.steps - value)} short`;
		}
		case 'sleep': {
			const value = day.sleepMinutes ?? 0;
			return `${formatSleep(value)} · ${formatSleep(LOCKIN_TARGETS.sleepMinutes - value)} short`;
		}
		case 'gym':
			return 'No session';
		case 'mate':
			return 'Skipped';
		case 'clean':
			return 'Relapsed';
	}
}

/** "1 push, 2 pull". */
export function owedSessions(needed: Record<RequiredSession, number>) {
	return Object.entries(needed)
		.filter(([, count]) => count > 0)
		.map(([session, count]) => `${count} ${session}`)
		.join(', ');
}

/**
 * Everything that went wrong so far, newest first and with how far off it was.
 * A weekly miss is dated on the last day of its week lived so far, and reads
 * before that day's own misses.
 */
export function lockinMisses(
	window: LockinWindow,
	log: LockinLog,
	today: string,
): LockinMiss[] {
	const misses: LockinMiss[] = [];
	const readable = new Set(readableDates(window, log, today));

	challengeWeeks(window).forEach((week, index) => {
		const last = week.filter((date) => readable.has(date)).at(-1);
		if (!last) return;
		const report = weekReport(week, log);
		if (report.calories.verdict === 'missed')
			misses.push({
				date: last,
				kpi: 'calories',
				detail: `${formatCount(report.calories.total)} / ${formatCount(LOCKIN_TARGETS.caloriesPerWeek)} kcal this week`,
				week: index + 1,
			});
		if (report.gym.verdict === 'missed')
			misses.push({
				date: last,
				kpi: 'gym',
				detail: `Week short of ${owedSessions(report.gym.needed)}`,
				week: index + 1,
			});
	});

	for (const date of readable) {
		const day = log.get(date);
		if (!day) continue;
		const verdicts = dayVerdicts(date, day);
		for (const kpi of KPI_KEYS)
			if (verdicts[kpi] === 'missed')
				misses.push({ date, kpi, detail: missDetail(kpi, day) });
	}

	// Stable, so within a date weekly misses stay first and days keep KPI order.
	return misses.sort((a, b) =>
		a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
	);
}
