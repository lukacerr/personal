import {
	type AppSystem,
	matchesCommandQuery,
	refreshIndexStore,
	type SystemSummaryRow,
	systemPath,
} from '@web/lib/app-systems';
import {
	challengeProgress,
	challengeWeeks,
	formatCount,
	formatDay,
	LOCKIN_TARGETS,
	type LockinLog,
	localDateOf,
	nextDayToLog,
	weekReport,
} from '@web/lib/lockin';
import type { LockinWindow } from '@web/lib/lockin-api';
import {
	lockinLogOf,
	lockinSnapshot,
	useLockinStore,
} from '@web/lib/lockin-store';
import { TargetIcon } from 'lucide-react';

const LOCKIN_PATH = '/lockin';

/** Opens the form on the first day still missing answers; the screen picks it. */
export const LOG_NEXT_DAY_PATH = systemPath(LOCKIN_PATH, { new: '1' });

/**
 * Which day it is, what is waiting to be logged, and the week's calorie budget
 * left — the one number worth checking before eating something.
 *
 * Over budget says so in words rather than as a negative: the summary has no
 * colour to raise its voice with, and "-350" reads like a typo.
 */
export function lockinSummaryRows(
	window: LockinWindow | undefined,
	log: LockinLog,
	today: string,
): SystemSummaryRow[] {
	// Silence until the log has loaded: "Day 0" would be a claim, not an absence.
	if (!window) return [];

	const progress = challengeProgress(window, today);
	if (progress.phase === 'upcoming')
		return [{ key: 'start', label: 'Starts', detail: formatDay(window.from) }];

	const rows: SystemSummaryRow[] = [
		{ key: 'day', label: 'Day', detail: `${progress.day} / ${progress.total}` },
	];

	const next = nextDayToLog(window, log, today);
	if (next)
		rows.push({
			key: 'log',
			label: 'To log',
			detail: formatDay(next),
			to: LOG_NEXT_DAY_PATH,
		});

	const week = challengeWeeks(window).find((dates) => dates.includes(today));
	if (week) {
		const left =
			LOCKIN_TARGETS.caloriesPerWeek - weekReport(week, log).calories.total;
		rows.push(
			left >= 0
				? {
						key: 'kcal',
						label: 'Kcal left this week',
						detail: formatCount(left),
					}
				: {
						key: 'kcal',
						label: 'Kcal this week',
						detail: `${formatCount(-left)} over`,
					},
		);
	}

	return rows;
}

export const lockinSystem: AppSystem = {
	key: 'lockin',
	heading: 'Lock-in',
	icon: TargetIcon,
	clearLocalData: () => useLockinStore.getState().reset(),

	/** No local database for the shell to watch, so the store reports for itself. */
	subscribe: (onChange) =>
		useLockinStore.subscribe((state, previous) => {
			if (state.days !== previous.days || state.window !== previous.window)
				onChange();
		}),

	refresh: refreshIndexStore(useLockinStore),

	/**
	 * The sidebar reads this log from every screen — the day to log and the
	 * calories left matter most away from the dashboard — so the pull follows
	 * it there. Still no timer: it ages on the coordinator's clock.
	 */
	refreshEverywhere: true,

	/** A pure read of what the last pull left, like every summary. */
	async loadSummary() {
		const { window, days } = lockinSnapshot();
		return {
			rows: lockinSummaryRows(
				window,
				lockinLogOf(days),
				localDateOf(new Date()),
			),
		};
	},

	/** Only the action: a day is read on the dashboard, beside its week. */
	async searchCommands(query, limit) {
		if (limit < 1) return [];
		if (!matchesCommandQuery(query, 'Log day', 'lock-in lockin track kpi'))
			return [];
		return [
			{ id: 'log', label: 'Log day', detail: 'Lock-in', to: LOG_NEXT_DAY_PATH },
		];
	},

	async loadBreadcrumbTrail() {
		return [];
	},
};
