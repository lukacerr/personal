import {
	KPI_ICONS,
	KPI_TARGET_TEXT,
	MARK_LABELS,
	type Mark,
	VerdictLegend,
	VerdictPill,
} from '@web/components/lockin/lockin-verdict';
import { LockinWeightCard } from '@web/components/lockin/lockin-weight';
import { Card } from '@web/components/ui/card';
import {
	challengeWeeks,
	dayVerdicts,
	formatCount,
	formatDay,
	formatSleep,
	KPI_KEYS,
	KPI_LABELS,
	type KpiKey,
	kpiStreaks,
	kpiTallies,
	type LockinLog,
} from '@web/lib/lockin';
import type { LockinDay, LockinWindow } from '@web/lib/lockin-api';
import { cn } from '@web/lib/utils';
import { FlameIcon } from 'lucide-react';

const mean = (values: number[]) =>
	values.length === 0
		? undefined
		: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

const numbers = (days: LockinDay[], read: (day: LockinDay) => number | null) =>
	days.map(read).filter((value): value is number => value !== null);

/** The one figure that describes the KPI beyond its streak, where there is one. */
function headline(kpi: KpiKey, days: LockinDay[]) {
	switch (kpi) {
		case 'calories': {
			const value = mean(numbers(days, (day) => day.calories));
			return value === undefined ? undefined : `${formatCount(value)} avg`;
		}
		case 'protein': {
			const value = mean(numbers(days, (day) => day.proteinGrams));
			return value === undefined ? undefined : `${value} g avg`;
		}
		case 'steps': {
			const value = mean(numbers(days, (day) => day.steps));
			return value === undefined ? undefined : `${formatCount(value)} avg`;
		}
		case 'sleep': {
			const value = mean(numbers(days, (day) => day.sleepMinutes));
			return value === undefined ? undefined : `${formatSleep(value)} avg`;
		}
		case 'gym': {
			const sessions = days.filter(
				(day) => day.gym && day.gym !== 'skipped',
			).length;
			return `${sessions} session${sessions === 1 ? '' : 's'}`;
		}
		default:
			return undefined;
	}
}

/** What the hover says about one square: the day, and the answer behind it. */
function answerOf(kpi: KpiKey, day: LockinDay | undefined) {
	if (!day) return undefined;
	switch (kpi) {
		case 'calories':
			return day.calories === null
				? undefined
				: `${formatCount(day.calories)} kcal`;
		case 'protein':
			return day.proteinGrams === null ? undefined : `${day.proteinGrams} g`;
		case 'steps':
			return day.steps === null ? undefined : formatCount(day.steps);
		case 'sleep':
			return day.sleepMinutes === null
				? undefined
				: formatSleep(day.sleepMinutes);
		case 'gym':
			return day.gym ?? undefined;
		default:
			return undefined;
	}
}

/**
 * One card per KPI, each on its own: its streak, its record, and the whole
 * challenge as a Monday-first grid, so a bad week of one habit does not hide
 * behind four good ones.
 */
export function LockinKpis({
	window,
	log,
	today,
}: {
	window: LockinWindow;
	log: LockinLog;
	today: string;
}) {
	const streaks = kpiStreaks(window, log, today);
	const tallies = kpiTallies(window, log, today);
	const weeks = challengeWeeks(window);
	const logged = [...log.values()];
	const verdicts = new Map(
		weeks.flat().map((date) => [date, dayVerdicts(date, log.get(date))]),
	);

	return (
		<section
			aria-labelledby="lockin-kpis"
			className="@container flex flex-col gap-3"
		>
			{/* The legend rides the heading row rather than spending one of its own. */}
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<h2 id="lockin-kpis" className="font-heading font-semibold text-lg">
					Habits
				</h2>
				<VerdictLegend />
			</div>
			<ul className="grid @4xl:grid-cols-4 @xs:grid-cols-2 grid-cols-1 gap-3 @lg:gap-4">
				{KPI_KEYS.map((kpi) => {
					const Icon = KPI_ICONS[kpi];
					const streak = streaks[kpi];
					const tally = tallies[kpi];
					const judged = tally.met + tally.missed;
					const figure = headline(kpi, logged);

					return (
						<li key={kpi}>
							<Card size="sm" className="h-full gap-3 px-3 @lg:gap-4 @lg:px-4">
								<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
									<h3 className="flex items-center gap-2 font-medium">
										<Icon
											aria-hidden
											className="size-4 text-muted-foreground"
										/>
										{KPI_LABELS[kpi]}
									</h3>
									<span className="font-mono text-muted-foreground text-xs tabular-nums">
										{KPI_TARGET_TEXT[kpi]}
									</span>
								</div>

								<div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
									<div className="flex flex-col gap-0.5">
										<p className="flex items-baseline gap-1.5">
											<FlameIcon
												aria-hidden
												className={cn(
													'size-5 self-center',
													streak.current > 0
														? 'fill-orange-500/20 text-orange-500'
														: 'text-muted-foreground',
												)}
											/>
											<span className="font-mono font-semibold text-2xl tabular-nums @lg:text-3xl">
												{streak.current}
											</span>
											<span className="text-muted-foreground text-sm">
												{streak.current === 1 ? 'day' : 'days'}
											</span>
										</p>
										<p className="text-muted-foreground text-xs">
											Best{' '}
											<span className="font-mono tabular-nums">
												{streak.best}
											</span>
											{judged > 0 ? (
												<>
													{' · '}
													<span className="font-mono tabular-nums">
														{tally.met}/{judged}
													</span>{' '}
													on target
												</>
											) : null}
										</p>
									</div>
									{figure ? (
										<span className="font-mono text-sm tabular-nums">
											{figure}
										</span>
									) : null}
								</div>

								{/* Pills, not squares: a row per week at a fifth of the height. */}
								<ol
									aria-label={`${KPI_LABELS[kpi]}, day by day`}
									className="mt-auto grid h-18 grid-cols-7 content-between gap-x-1"
								>
									{weeks.flat().map((date) => {
										const verdict = verdicts.get(date)?.[kpi] ?? 'pending';
										// Ahead of today, unanswered is not late: it has not come yet.
										const mark: Mark =
											date > today && verdict === 'pending'
												? 'future'
												: verdict;
										const answer = answerOf(kpi, log.get(date));
										return (
											<li key={date}>
												<VerdictPill
													mark={mark}
													label={[formatDay(date), answer, MARK_LABELS[mark]]
														.filter(Boolean)
														.join(' · ')}
													className={cn(
														date === today &&
															'outline-2 outline-foreground outline-offset-1',
													)}
												/>
											</li>
										);
									})}
								</ol>
							</Card>
						</li>
					);
				})}
				{/* Eighth, so the grid closes on an even row at two and four columns. */}
				<li>
					<LockinWeightCard window={window} log={log} today={today} />
				</li>
			</ul>
		</section>
	);
}
