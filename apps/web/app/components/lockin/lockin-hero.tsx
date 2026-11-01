import { Button } from '@web/components/ui/button';
import { Card } from '@web/components/ui/card';
import {
	challengeProgress,
	challengeWeeks,
	formatDay,
	isDayComplete,
	type LockinLog,
	nextDayToLog,
} from '@web/lib/lockin';
import type { LockinWindow } from '@web/lib/lockin-api';
import { cn } from '@web/lib/utils';
import { CheckIcon, PencilLineIcon } from 'lucide-react';

function tickState(date: string, log: LockinLog, today: string) {
	if (isDayComplete(date, log.get(date))) return 'complete';
	if (log.has(date)) return 'partial';
	// From today on, unlogged is still on time, not behind.
	return date >= today ? 'future' : 'empty';
}

const TICK_STYLES = {
	complete: 'bg-foreground',
	partial: 'bg-chart-4',
	empty: 'bg-destructive/70',
	future: 'bg-muted',
} as const;

const TICK_LABELS = {
	complete: 'logged',
	partial: 'partly logged',
	empty: 'not logged',
	future: 'open',
} as const;

/**
 * Where the challenge stands: which day it is, and the one action that keeps
 * it honest — logging the next day. The 35 ticks are the log itself, so a gap
 * left behind shows from across the room.
 */
export function LockinHero({
	window,
	log,
	today,
	onLog,
}: {
	window: LockinWindow;
	log: LockinLog;
	today: string;
	onLog: (date: string) => void;
}) {
	const progress = challengeProgress(window, today);
	const weeks = challengeWeeks(window);
	const week = weeks.findIndex((dates) => dates.includes(today)) + 1;
	// Before the start, nothing is owed yet, but the first day can be logged.
	const next =
		progress.phase === 'upcoming'
			? isDayComplete(window.from, log.get(window.from))
				? undefined
				: window.from
			: nextDayToLog(window, log, today);
	const editable =
		progress.phase === 'running'
			? today
			: progress.phase === 'upcoming'
				? window.from
				: window.to;

	return (
		<Card size="sm" className="gap-4 px-4 sm:px-6">
			{/* One line when there is room: the breadcrumb already says Lock-in. */}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
					{progress.phase === 'upcoming' ? (
						<h1 className="font-heading font-semibold text-2xl">
							Starts {formatDay(window.from)}
						</h1>
					) : (
						<h1 className="font-heading font-semibold text-2xl">
							Day <span className="font-mono tabular-nums">{progress.day}</span>
							<span className="font-normal text-muted-foreground">
								{' '}
								of {progress.total}
							</span>
						</h1>
					)}
					<p className="text-muted-foreground text-sm">
						{progress.phase === 'running'
							? `Week ${week} of ${weeks.length} · ${progress.total - progress.day} days to go`
							: progress.phase === 'finished'
								? 'Finished.'
								: `${progress.total} days, ${weeks.length} weeks, Sunday first.`}
						<span className="hidden sm:inline">
							{' · '}
							{formatDay(window.from).replace(/^w+ /, '')} –{' '}
							{formatDay(window.to).replace(/^w+ /, '')}
						</span>
					</p>
				</div>

				{next ? (
					<Button onClick={() => onLog(next)}>
						<PencilLineIcon aria-hidden />
						Log {formatDay(next)}
					</Button>
				) : (
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-1.5 text-sm">
							<CheckIcon aria-hidden className="size-4 text-success" />
							All caught up
						</span>
						<Button variant="outline" onClick={() => onLog(editable)}>
							<PencilLineIcon aria-hidden />
							Edit {formatDay(editable)}
						</Button>
					</div>
				)}
			</div>

			<ol aria-label="Days logged" className="flex gap-1.5 sm:gap-2">
				{weeks.map((dates, index) => (
					<li key={dates[0]} className="flex flex-1 gap-0.5 sm:gap-1">
						<span className="sr-only">Week {index + 1}</span>
						{dates.map((date) => {
							const state = tickState(date, log, today);
							return (
								<span
									key={date}
									role="img"
									aria-label={`${formatDay(date)}: ${TICK_LABELS[state]}`}
									title={`${formatDay(date)} · ${TICK_LABELS[state]}`}
									className={cn(
										'h-2.5 flex-1 rounded-full',
										TICK_STYLES[state],
										date === today &&
											'outline-2 outline-foreground outline-offset-2',
									)}
								/>
							);
						})}
					</li>
				))}
			</ol>
		</Card>
	);
}
