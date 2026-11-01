import {
	MARK_LABELS,
	VerdictMark,
} from '@web/components/lockin/lockin-verdict';
import { Badge } from '@web/components/ui/badge';
import { Card } from '@web/components/ui/card';
import {
	challengeWeeks,
	formatCount,
	formatDay,
	isSunday,
	LOCKIN_TARGETS,
	type LockinLog,
	type RequiredSession,
	weekReport,
} from '@web/lib/lockin';
import type { LockinDay, LockinWindow } from '@web/lib/lockin-api';
import { cn } from '@web/lib/utils';
import { DumbbellIcon, UtensilsIcon } from 'lucide-react';

const REQUIRED_SESSIONS: RequiredSession[] = ['push', 'pull', 'legs-core'];

const SESSION_LABELS: Record<NonNullable<LockinDay['gym']>, string> = {
	push: 'Push',
	pull: 'Pull',
	'legs-core': 'Legs',
	cardio: 'Cardio',
	skipped: 'Skip',
};

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The pace that spends the week's budget evenly, as a share of the daily cap. */
const PACE = LOCKIN_TARGETS.caloriesPerWeek / 7 / LOCKIN_TARGETS.caloriesPerDay;

function CalorieBars({ dates, log }: { dates: string[]; log: LockinLog }) {
	const cap = LOCKIN_TARGETS.caloriesPerDay;
	return (
		<div aria-hidden className="flex flex-col gap-1">
			<div className="relative flex h-10 items-end gap-1">
				<span
					className="absolute inset-x-0 border-foreground/30 border-t border-dashed"
					style={{ bottom: `${PACE * 100}%` }}
				/>
				{dates.map((date) => {
					const kcal = log.get(date)?.calories ?? null;
					const over = kcal !== null && kcal > cap;
					return (
						<span
							key={date}
							title={`${formatDay(date)} · ${kcal === null ? 'not logged' : `${formatCount(kcal)} kcal`}`}
							className="relative flex h-full flex-1 items-end"
						>
							<span
								className={cn(
									'w-full rounded-t-[4px]',
									kcal === null
										? 'h-0.5 bg-muted'
										: over
											? 'bg-destructive'
											: 'bg-foreground',
								)}
								style={
									kcal === null
										? undefined
										: {
												height: `${Math.max(4, Math.min(1, kcal / cap) * 100)}%`,
											}
								}
							/>
						</span>
					);
				})}
			</div>
			<div className="flex gap-1 text-center text-[10px] text-muted-foreground">
				{WEEKDAY_INITIALS.map((initial, index) => (
					<span key={dates[index]} className="flex-1">
						{initial}
					</span>
				))}
			</div>
		</div>
	);
}

function SessionCells({ dates, log }: { dates: string[]; log: LockinLog }) {
	return (
		<ol className="grid grid-cols-7 gap-1">
			{dates.map((date) => {
				const gym = log.get(date)?.gym ?? null;
				const rest = isSunday(date);
				const label = rest ? 'Rest' : gym ? SESSION_LABELS[gym] : '·';
				return (
					<li
						key={date}
						title={`${formatDay(date)} · ${rest ? 'rest day' : gym ? SESSION_LABELS[gym] : 'not logged'}`}
						className={cn(
							'flex h-7 min-w-0 items-center justify-center truncate rounded-md px-0.5 text-[11px]',
							rest
								? 'text-muted-foreground'
								: gym === 'skipped'
									? 'bg-destructive text-white'
									: gym
										? 'bg-foreground text-background'
										: 'border border-dashed text-muted-foreground',
						)}
					>
						{label}
					</li>
				);
			})}
		</ol>
	);
}

/**
 * The two rules that only exist per week: the calorie budget and the mix of
 * sessions. Each says how much is left while it can still be met, and turns as
 * soon as it cannot.
 *
 * One row per week in a single card. Each rule shows its days, not only its
 * total: which day ate the budget, which day had no session — the bars run
 * against the daily cap, with the even pace for the week dashed across them.
 */
export function LockinWeeks({
	window,
	log,
	today,
}: {
	window: LockinWindow;
	log: LockinLog;
	today: string;
}) {
	const weeks = challengeWeeks(window);
	const budget = LOCKIN_TARGETS.caloriesPerWeek;
	const quota = LOCKIN_TARGETS.sessionsPerWeek;

	return (
		<section
			aria-labelledby="lockin-weeks"
			className="@container flex flex-col gap-3"
		>
			<h2 id="lockin-weeks" className="font-heading font-semibold text-lg">
				Weeks
			</h2>
			<Card size="sm" className="gap-0 px-4 py-1 sm:px-6">
				<ol className="divide-y">
					{weeks.map((dates, index) => {
						const first = dates[0] ?? window.from;
						const last = dates.at(-1) ?? window.to;
						const current = first <= today && last >= today;
						const shown = first <= today || dates.some((date) => log.has(date));
						const report = weekReport(dates, log);
						const total = report.calories.total;
						const over = total > budget;

						// A week with nothing in it yet is one line: dates, and nothing else to say.
						if (!shown)
							return (
								<li
									key={first}
									className="flex flex-wrap items-baseline gap-x-3 py-3 text-muted-foreground"
								>
									<h3 className="font-medium text-sm">Week {index + 1}</h3>
									<span className="text-xs">
										{formatDay(first)} – {formatDay(last)}
									</span>
									<span className="ml-auto text-xs">Upcoming</span>
								</li>
							);

						return (
							<li
								key={first}
								className="grid @4xl:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-8 gap-y-3 py-4"
							>
								<div className="flex items-center justify-between gap-2 @4xl:flex-col @4xl:items-start @4xl:gap-1">
									<h3 className="flex items-center gap-2 font-medium">
										Week {index + 1}
										{current ? <Badge variant="secondary">Now</Badge> : null}
									</h3>
									<span className="text-muted-foreground text-xs">
										{formatDay(first)} – {formatDay(last)}
									</span>
								</div>

								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between gap-2">
										<span className="flex items-center gap-1.5 text-sm">
											<UtensilsIcon
												aria-hidden
												className="size-4 text-muted-foreground"
											/>
											<span className="font-mono tabular-nums">
												{formatCount(total)}
											</span>
											<span className="text-muted-foreground text-xs">
												/ {formatCount(budget)} kcal
											</span>
										</span>
										<span className="flex items-center gap-2">
											<span
												className={cn(
													'font-mono text-xs tabular-nums',
													over
														? 'font-medium text-destructive'
														: 'text-muted-foreground',
												)}
											>
												{over
													? `${formatCount(total - budget)} over`
													: `${formatCount(budget - total)} left`}
											</span>
											<VerdictMark
												mark={report.calories.verdict}
												label={`Week ${index + 1} calories: ${MARK_LABELS[report.calories.verdict]}`}
												className="size-5 shrink-0"
											/>
										</span>
									</div>
									<CalorieBars dates={dates} log={log} />
								</div>

								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between gap-2">
										<span className="flex items-center gap-1.5 text-sm">
											<DumbbellIcon
												aria-hidden
												className="size-4 text-muted-foreground"
											/>
											Sessions
										</span>
										<span className="flex items-center gap-2">
											<span className="font-mono text-xs tabular-nums">
												{REQUIRED_SESSIONS.map((session, position) => {
													const done = Math.min(
														report.gym.counts[session],
														quota[session],
													);
													return (
														<span
															key={session}
															className={cn(
																done < quota[session] &&
																	'text-muted-foreground',
															)}
														>
															{position > 0 ? ' · ' : ''}
															{SESSION_LABELS[session]} {done}/{quota[session]}
														</span>
													);
												})}
											</span>
											<VerdictMark
												mark={report.gym.verdict}
												label={`Week ${index + 1} sessions: ${MARK_LABELS[report.gym.verdict]}`}
												className="size-5 shrink-0"
											/>
										</span>
									</div>
									<SessionCells dates={dates} log={log} />
								</div>
							</li>
						);
					})}
				</ol>
			</Card>
		</section>
	);
}
