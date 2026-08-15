import {
	CalendarItemRow,
	type ItemHandlers,
	itemKey,
} from '@web/components/calendar/calendar-item';
import { Badge } from '@web/components/ui/badge';
import { Card } from '@web/components/ui/card';
import {
	type CalendarCompletion,
	type CalendarDayGroup,
	type CalendarEvent,
	completionsByKey,
	dayAgenda,
	weekBuckets,
} from '@web/lib/calendar';
import { cn } from '@web/lib/utils';
import { useMemo, useState } from 'react';

/**
 * The window's days, one bucket each unless a custom group reads several as
 * one. A day with nothing visible does not render at all — hiding today's
 * empty bucket is exactly what moves the eye to the next day that has
 * something. Every bucket is also a drop target: dragging a one-off onto it
 * is how a plan moves by hand.
 */
export function CalendarWeek({
	window: week,
	today,
	events,
	completions,
	groups,
	showDone,
	selectedKey,
	editingKey,
	onDropOnDay,
	...handlers
}: {
	window: { start: string; end: string };
	today: string;
	events: CalendarEvent[];
	completions: CalendarCompletion[];
	groups: CalendarDayGroup[];
	/** Done rows hide by default; the count in the heading keeps the credit. */
	showDone: boolean;
	selectedKey: string | null;
	editingKey: string | null;
	onDropOnDay: (eventId: string, date: string) => void;
} & ItemHandlers) {
	const [dropDate, setDropDate] = useState<string | null>(null);

	// Memoized on what actually feeds it: the selection travels as a prop, and
	// re-expanding ~21 days of series per arrow keypress is exactly the
	// roughness a held key turns into.
	const buckets = useMemo(() => {
		const resolved = completionsByKey(completions);
		return weekBuckets(week.start, week.end, groups)
			.map((bucket) => {
				const items = bucket.dates.flatMap((date) =>
					dayAgenda(events, resolved, date),
				);
				return {
					...bucket,
					items,
					visible: showDone
						? items
						: items.filter((item) => item.status !== 'done'),
				};
			})
			.filter((bucket) => bucket.visible.length > 0);
	}, [completions, week.start, week.end, groups, events, showDone]);

	if (buckets.length === 0)
		return (
			<p className="py-2 text-muted-foreground text-sm">
				Nothing in these days.
			</p>
		);

	return (
		<div className="flex flex-col gap-3">
			{buckets.map((bucket) => {
				const done = bucket.items.filter(
					(item) => item.status === 'done',
				).length;
				const isToday = bucket.dates.includes(today);
				const target = bucket.dates[0] ?? week.start;

				return (
					<Card
						key={bucket.key}
						onDragOver={(drag) => {
							drag.preventDefault();
							setDropDate(target);
						}}
						onDragLeave={() => setDropDate(null)}
						onDrop={(drag) => {
							drag.preventDefault();
							setDropDate(null);
							const id = drag.dataTransfer.getData('text/plain');
							if (id) onDropOnDay(id, target);
						}}
						className={cn(
							'gap-1 py-3',
							isToday && 'border-primary/40',
							dropDate === target && 'ring-2 ring-ring/50',
						)}
					>
						<div className="flex items-center gap-2 px-4">
							{/* One accessible name even though the date part renders in mono. */}
							<h3
								aria-label={`${bucket.title} ${bucket.range}`.trim()}
								className="flex items-baseline gap-2 font-medium text-base"
							>
								{bucket.title ? <span aria-hidden>{bucket.title}</span> : null}
								<span aria-hidden className="font-mono tabular-nums">
									{bucket.range}
								</span>
							</h3>
							{isToday ? <Badge variant="secondary">Today</Badge> : null}
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{done}/{bucket.items.length}
							</span>
						</div>
						<ul className="flex flex-col divide-y px-4">
							{bucket.visible.map((item) => (
								<CalendarItemRow
									key={itemKey(item)}
									item={item}
									today={today}
									showDate={bucket.dates.length > 1}
									selected={selectedKey === itemKey(item)}
									editing={editingKey === itemKey(item)}
									{...handlers}
								/>
							))}
						</ul>
					</Card>
				);
			})}
		</div>
	);
}
