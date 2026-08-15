import {
	CalendarItemRow,
	type ItemHandlers,
	itemKey,
} from '@web/components/calendar/calendar-item';
import { Button } from '@web/components/ui/button';
import { Card } from '@web/components/ui/card';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import {
	type AgendaItem,
	backlogItems,
	type CalendarEvent,
} from '@web/lib/calendar';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

/** A backlog row wears the same shape as any agenda item, minus the day. */
export function toBacklogItem(event: CalendarEvent): AgendaItem {
	return {
		event,
		date: '',
		status: event.completedAt !== null ? 'done' : 'pending',
		recurring: false,
	};
}

/**
 * The dateless list the note kept pinned in its opening quote. No checkboxes
 * here: what gets handled simply gets deleted, so a row is either waiting or
 * gone. New entries arrive through the quick-add with `!b`.
 */
export function CalendarBacklog({
	events,
	today,
	selectedKey,
	editingKey,
	...handlers
}: {
	events: CalendarEvent[];
	today: string;
	selectedKey: string | null;
	editingKey: string | null;
} & ItemHandlers) {
	const [open, setOpen] = useState(true);
	const items = backlogItems(events);

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<Card className="gap-1 border-0 bg-transparent py-1 shadow-none">
				<div className="flex items-center gap-2 px-4">
					<CollapsibleTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								className="-ml-2 gap-2 font-medium text-sm"
							>
								<ChevronDownIcon
									className={`size-4 transition-transform ${open ? '' : '-rotate-90'}`}
								/>
								Backlog
								<span className="font-mono text-muted-foreground text-xs tabular-nums">
									{items.length}
								</span>
							</Button>
						}
					/>
				</div>
				<CollapsibleContent>
					{items.length > 0 ? (
						<ul className="flex flex-col divide-y px-4">
							{items.map((event) => {
								const item = toBacklogItem(event);
								return (
									<CalendarItemRow
										key={event.id}
										item={item}
										today={today}
										showTime={false}
										checkable={false}
										selected={selectedKey === itemKey(item)}
										editing={editingKey === itemKey(item)}
										{...handlers}
									/>
								);
							})}
						</ul>
					) : (
						<p className="px-4 py-1 text-muted-foreground text-sm">
							Nothing waiting — `!b` in the add line drops one here.
						</p>
					)}
				</CollapsibleContent>
			</Card>
		</Collapsible>
	);
}
