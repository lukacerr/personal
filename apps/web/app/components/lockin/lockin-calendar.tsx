import { KPI_ICONS } from '@web/components/lockin/lockin-verdict';
import { Card } from '@web/components/ui/card';
import {
	challengeWeeks,
	dayAccess,
	dayVerdicts,
	formatDay,
	isDayComplete,
	KPI_KEYS,
	KPI_LABELS,
	type LockinLog,
	type Verdict,
} from '@web/lib/lockin';
import type { LockinWindow } from '@web/lib/lockin-api';
import { cn } from '@web/lib/utils';
import { CheckIcon, LockIcon } from 'lucide-react';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayNumber = (date: string) => Number(date.slice(8));

const ICON_TONES: Record<Verdict, string> = {
	met: 'text-success',
	missed: 'text-destructive',
	pending: 'text-muted-foreground/35',
	rest: 'text-muted-foreground/35',
};

/**
 * The log as a calendar, and the way into any day of it — past or future,
 * as long as the day before is complete.
 *
 * Wide, every cell shows all seven habits as icons toned by how they went, so
 * a day reads at a glance without opening it. Narrow, there is room only for
 * what went wrong: a check when nothing did, the icon of each miss otherwise.
 */
export function LockinCalendar({
	window,
	log,
	today,
	onOpen,
}: {
	window: LockinWindow;
	log: LockinLog;
	today: string;
	onOpen: (date: string) => void;
}) {
	const weeks = challengeWeeks(window);

	return (
		<section
			aria-labelledby="lockin-calendar"
			className="@container/days flex flex-col gap-3"
		>
			<h2 id="lockin-calendar" className="font-heading font-semibold text-lg">
				Days
			</h2>
			<Card size="sm" className="gap-2 px-2 sm:px-4">
				<div aria-hidden className="grid grid-cols-7 gap-1 sm:gap-2">
					{WEEKDAYS.map((weekday) => (
						<span
							key={weekday}
							className="text-center text-muted-foreground text-xs"
						>
							{weekday}
						</span>
					))}
				</div>
				<ol className="grid grid-cols-7 gap-1 sm:gap-2">
					{weeks.flat().map((date) => {
						const day = log.get(date);
						const open = dayAccess(date, window, log) === 'open';
						const ahead = date > today;
						const complete = isDayComplete(date, day);
						const verdicts = dayVerdicts(date, day);
						const missed = KPI_KEYS.filter((kpi) => verdicts[kpi] === 'missed');
						const status = !open
							? 'opens once the day before is logged'
							: complete
								? missed.length === 0
									? 'all on target'
									: `missed ${missed.map((kpi) => KPI_LABELS[kpi]).join(', ')}`
								: day
									? 'partly logged'
									: ahead || date === today
										? 'open'
										: 'not logged';

						return (
							<li key={date}>
								<button
									type="button"
									disabled={!open}
									onClick={() => onOpen(date)}
									aria-label={`${formatDay(date)}: ${status}`}
									title={`${formatDay(date)} · ${status}`}
									className={cn(
										'flex aspect-square w-full min-w-0 flex-col items-start justify-between gap-1 rounded-xl border p-1 text-left transition-colors sm:p-2 @3xl/days:aspect-auto @3xl/days:min-h-[4.5rem] @5xl/days:min-h-16 @5xl/days:p-1.5',
										'focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-muted',
										!open &&
											(ahead
												? 'border-dashed text-muted-foreground/60'
												: 'bg-muted/40 text-muted-foreground'),
										open &&
											!complete &&
											date < today &&
											'border-destructive/50 bg-destructive/5',
										date === today && 'border-2 border-foreground',
									)}
								>
									<span className="flex w-full items-center justify-between gap-1">
										<span className="font-mono text-xs tabular-nums sm:text-sm">
											{dayNumber(date)}
										</span>
										{!open && !ahead ? (
											<LockIcon aria-hidden className="size-3.5" />
										) : complete && missed.length === 0 ? (
											<CheckIcon
												aria-hidden
												className="size-4 text-success"
												strokeWidth={3}
											/>
										) : open && !complete && day ? (
											<span
												aria-hidden
												className="size-1.5 rounded-full bg-chart-4"
											/>
										) : null}
									</span>

									{day ? (
										<>
											{/* Wide: all seven, toned by verdict. */}
											<span
												aria-hidden
												className="hidden grid-cols-4 gap-1 @3xl/days:grid @5xl/days:grid-cols-7 @5xl/days:gap-0.5"
											>
												{KPI_KEYS.map((kpi) => {
													const Icon = KPI_ICONS[kpi];
													return (
														<Icon
															key={kpi}
															className={cn(
																'size-3.5',
																ICON_TONES[verdicts[kpi]],
															)}
														/>
													);
												})}
											</span>
											{/* Narrow: only what went wrong. */}
											<span
												aria-hidden
												className="flex flex-wrap gap-0.5 @3xl/days:hidden"
											>
												{missed.map((kpi) => {
													const Icon = KPI_ICONS[kpi];
													return (
														<Icon
															key={kpi}
															className="size-3 text-destructive sm:size-3.5"
														/>
													);
												})}
											</span>
										</>
									) : null}
								</button>
							</li>
						);
					})}
				</ol>
			</Card>
		</section>
	);
}
