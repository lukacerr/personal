import {
	CalendarItemRow,
	type ItemHandlers,
	itemKey,
} from '@web/components/calendar/calendar-item';
import { Card } from '@web/components/ui/card';
import {
	type CalendarCompletion,
	type CalendarEvent,
	scheduleItems,
} from '@web/lib/calendar';
import { useMemo } from 'react';

/**
 * Everything beyond the visible days — the note's "Schedule" section, flat
 * and dated exactly as it was written there. One-offs appear however far away
 * they are; a series contributes its single next occurrence, flagged, so a
 * sparse one stays findable without flooding the list. Actions live in the
 * row menu: the column is narrow and inline buttons wrapped complex rows.
 */
export function CalendarSchedule({
	events,
	completions,
	window: visible,
	today,
	showDone,
	selectedKey,
	editingKey,
	...handlers
}: {
	events: CalendarEvent[];
	completions: CalendarCompletion[];
	/** The days on screen: series visible there stay out of this list. */
	window: { start: string; end: string };
	today: string;
	showDone: boolean;
	selectedKey: string | null;
	editingKey: string | null;
} & ItemHandlers) {
	// Memoized on what feeds it: the selection travels as a prop, and rescanning
	// a year ahead for every series on each arrow keypress adds up. The window
	// has to arrive referentially stable for this to hold — the route passes its
	// own memoized `week`.
	const items = useMemo(
		() =>
			scheduleItems(events, completions, visible).filter(
				(item) => showDone || item.status !== 'done',
			),
		[events, completions, visible, showDone],
	);

	return (
		<section aria-label="Schedule" className="flex flex-col gap-2">
			<h2 className="flex items-baseline gap-2 font-medium text-base">
				Schedule
				<span className="font-mono text-muted-foreground text-xs tabular-nums">
					{items.length}
				</span>
			</h2>
			{items.length > 0 ? (
				<Card className="gap-0 py-1.5">
					<ul className="flex flex-col divide-y px-4">
						{items.map((item) => (
							<CalendarItemRow
								key={itemKey(item)}
								item={item}
								today={today}
								showDate
								selected={selectedKey === itemKey(item)}
								editing={editingKey === itemKey(item)}
								{...handlers}
							/>
						))}
					</ul>
				</Card>
			) : (
				<p className="text-muted-foreground text-sm">
					Nothing beyond these days.
				</p>
			)}
		</section>
	);
}
