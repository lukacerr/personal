import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
	type AgendaItem,
	formatQuickAdd,
	formatShortDate,
	formatTime,
	parseDetailLines,
	parseQuickAdd,
	type QuickAddParse,
} from '@web/lib/calendar';
import type { CalendarEvent } from '@web/lib/calendar-api';
import type { LocalEvent } from '@web/lib/calendar-db';
import { isEditableTarget } from '@web/lib/keyboard';
import { cn } from '@web/lib/utils';
import {
	CopyIcon,
	MoreHorizontalIcon,
	PencilIcon,
	RepeatIcon,
	Trash2Icon,
	TriangleAlertIcon,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

/** One selection key per visible row: a series repeats across days. */
export function itemKey(item: AgendaItem) {
	return `${item.event.id}:${item.date || 'b'}`;
}

export type ItemHandlers = {
	/** Pending ↔ done. Skipping died as a concept; a moved plan is a new line. */
	onToggle: (item: AgendaItem) => void;
	/** Flips one line of the details checklist. */
	onToggleDetail: (item: AgendaItem, index: number) => void;
	onSelect: (item: AgendaItem) => void;
	/** Opens the row as its own text, in place. */
	onEdit: (item: AgendaItem) => void;
	/** A fresh copy, opened for editing — the fast way to make similar things. */
	onClone: (item: AgendaItem) => void;
	onDelete: (event: CalendarEvent) => void;
	/** Commits the inline text back onto the event; `null` means it was
	 * submitted empty, which reads as "delete this". */
	onCommitEdit: (event: CalendarEvent, parsed: QuickAddParse | null) => void;
	onCancelEdit: () => void;
};

/**
 * The row opened as the text it came from — `formatQuickAdd` and back, exact
 * inverses. Enter commits, Shift+Enter adds a details line, Escape discards.
 * Leaving the field commits too: an edit reached deliberately should not
 * evaporate because focus moved on.
 */
function InlineEditor({
	event,
	today,
	onCommit,
	onCancel,
}: {
	event: CalendarEvent;
	today: string;
	onCommit: (parsed: QuickAddParse | null) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(() => formatQuickAdd(event, today));
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const area = ref.current;
		if (!area) return;
		area.focus();
		area.setSelectionRange(area.value.length, area.value.length);
	}, []);

	function commit(viaEnter: boolean) {
		const parsed = parseQuickAdd(value, today);
		if (!parsed) {
			// Enter on an emptied row asks to delete it; a mere blur does not —
			// losing focus must never pop a destructive dialog.
			if (viaEnter) onCommit(null);
			else onCancel();
			return;
		}
		onCommit(parsed);
	}

	return (
		<textarea
			ref={ref}
			aria-label={`Edit ${event.title}`}
			value={value}
			rows={Math.max(1, value.split('\n').length)}
			onChange={(input) => setValue(input.target.value)}
			onBlur={() => commit(false)}
			onKeyDown={(input) => {
				if (input.key === 'Enter' && !input.shiftKey) {
					input.preventDefault();
					commit(true);
				}
				if (input.key === 'Escape') {
					input.preventDefault();
					onCancel();
				}
			}}
			className="w-full resize-none rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:border-ring"
		/>
	);
}

/**
 * The menu is the only form the actions take, at every width: the screen is
 * keyboard-first (`e`, `c`, Delete), so inline buttons bought nothing on
 * desktop and cost horizontal room the titles read better with.
 */
function RowActions({
	item,
	onEdit,
	onClone,
	onDelete,
}: {
	item: AgendaItem;
	onEdit: () => void;
	onClone: () => void;
	onDelete: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						className="max-sm:size-11"
						aria-label={`Actions for ${item.event.title}`}
					>
						<MoreHorizontalIcon />
					</Button>
				}
			/>
			<DropdownMenuContent
				align="end"
				// Closing must not reclaim focus an inline editor already took:
				// cloning opens the copy's editor while this menu is still on its
				// way out, and restoring focus to the trigger would blur the
				// editor — whose blur commits, closing it before one keystroke.
				finalFocus={() => !isEditableTarget(document.activeElement)}
			>
				<DropdownMenuItem onClick={onEdit}>
					<PencilIcon /> Edit
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onClone}>
					<CopyIcon /> Clone
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" onClick={onDelete}>
					<Trash2Icon /> Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * One row for every list on the screen. Selection travels by keyboard, the
 * row opens in place as text, and a one-off can be dragged onto another day
 * bucket — a series cannot: its days are the series' own business.
 */
function CalendarItemRowBase({
	item,
	today,
	showDate = false,
	showTime = true,
	/** The backlog carries no checkbox: what is finished simply gets deleted. */
	checkable = true,
	selected = false,
	editing = false,
	...handlers
}: {
	item: AgendaItem;
	today: string;
	showDate?: boolean;
	showTime?: boolean;
	checkable?: boolean;
	selected?: boolean;
	editing?: boolean;
} & ItemHandlers) {
	const { event, status } = item;
	const syncFailure = (event as LocalEvent).syncFailure;
	const ref = useRef<HTMLLIElement>(null);

	useEffect(() => {
		if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
	}, [selected]);

	if (editing)
		return (
			<li className="py-2">
				<InlineEditor
					event={event}
					today={today}
					onCommit={(parsed) => handlers.onCommitEdit(event, parsed)}
					onCancel={handlers.onCancelEdit}
				/>
			</li>
		);

	const detailLines = (() => {
		const seen = new Map<string, number>();
		return parseDetailLines(event.details).map((line, index) => {
			const occurrence = (seen.get(line.text) ?? 0) + 1;
			seen.set(line.text, occurrence);
			return { ...line, index, key: `${line.text}#${occurrence}` };
		});
	})();

	return (
		// The click only mirrors a selection model that is fully keyboard-driven
		// at the screen level (arrows walk every row); a per-row key handler
		// would double it.
		// biome-ignore lint/a11y/useKeyWithClickEvents: selection is keyboard-first via the screen-level arrow bindings
		<li
			ref={ref}
			data-selected={selected || undefined}
			draggable={!item.recurring}
			onDragStart={(drag) => {
				drag.dataTransfer.setData('text/plain', event.id);
				drag.dataTransfer.effectAllowed = 'move';
			}}
			onClick={() => handlers.onSelect(item)}
			className={cn(
				// `scroll-mt` is what keeps a keyboard selection visible: without
				// it, scrollIntoView parks the row underneath the pinned header
				// and toolbar when walking back up.
				'-mx-2 flex scroll-mt-40 scroll-mb-4 items-start gap-2.5 rounded-md px-2 py-2.5',
				selected && 'bg-muted/60 ring-1 ring-ring/40',
			)}
		>
			{checkable ? (
				<Checkbox
					className="mt-1"
					checked={status === 'done'}
					aria-label={
						item.date
							? `${event.title} · ${formatShortDate(item.date)}`
							: event.title
					}
					onCheckedChange={() => handlers.onToggle(item)}
				/>
			) : null}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					{/*
					 * Minimum widths, not fixed: a system font scale grows the text
					 * without growing a `w-12` box, and the hour was drawn over the
					 * title on a flip cover screen. Every cell holds the same five
					 * monospace characters — an untimed row gets figure-width blanks —
					 * so the columns widen together and titles stay aligned at any
					 * text scale.
					 */}
					{showDate && item.date ? (
						<span className="min-w-12 shrink-0 font-mono text-muted-foreground text-sm tabular-nums">
							{formatShortDate(item.date)}
						</span>
					) : null}
					{showTime ? (
						<span className="min-w-12 shrink-0 font-mono text-sm tabular-nums">
							{event.timeMinutes !== null
								? formatTime(event.timeMinutes)
								: '\u00a0'.repeat(5)}
						</span>
					) : null}
					<span
						className={cn(
							'text-base sm:text-[0.9375rem]',
							status === 'done' && 'text-muted-foreground line-through',
						)}
					>
						{event.title}
					</span>
					{item.recurring ? (
						<RepeatIcon
							aria-label="Repeats"
							className="size-3.5 shrink-0 self-center text-muted-foreground"
						/>
					) : null}
					{event.tag ? (
						<Badge variant="outline" className="text-muted-foreground text-xs">
							{event.tag}
						</Badge>
					) : null}
					{syncFailure ? (
						<Tooltip>
							<TooltipTrigger
								render={
									<TriangleAlertIcon
										aria-label="Not synced"
										className="size-3.5 shrink-0 self-center text-destructive"
									/>
								}
							/>
							<TooltipContent>{syncFailure}</TooltipContent>
						</Tooltip>
					) : null}
				</div>
				{detailLines.length > 0 ? (
					// Indented past the fixed columns so the sub-checks hang under the
					// title, like the note's nested bullets.
					<ul
						className={cn(
							'flex flex-col gap-1',
							[null, 'pl-14', 'pl-28'][
								(showDate && item.date ? 1 : 0) + (showTime ? 1 : 0)
							],
						)}
					>
						{detailLines.map((line) => (
							<li key={line.key} className="flex items-start gap-2">
								<Checkbox
									className="mt-0.5 size-3.5"
									checked={line.checked}
									aria-label={line.text}
									onCheckedChange={() =>
										handlers.onToggleDetail(item, line.index)
									}
								/>
								<span
									className={cn(
										'text-muted-foreground text-sm',
										line.checked && 'line-through opacity-70',
									)}
								>
									{line.text}
								</span>
							</li>
						))}
					</ul>
				) : null}
			</div>
			<RowActions
				item={item}
				onEdit={() => handlers.onEdit(item)}
				onClone={() => handlers.onClone(item)}
				onDelete={() => handlers.onDelete(event)}
			/>
		</li>
	);
}

/**
 * Memoized by value, handlers excluded on purpose: every handler acts only on
 * its arguments and setState/Dexie, so a stale closure cannot act on stale
 * data. Without this, each arrow keypress re-rendered every row on screen,
 * which is exactly the roughness a held key turns into.
 */
export const CalendarItemRow = memo(
	CalendarItemRowBase,
	(previous, next) =>
		previous.item.event === next.item.event &&
		previous.item.status === next.item.status &&
		previous.item.date === next.item.date &&
		previous.today === next.today &&
		previous.showDate === next.showDate &&
		previous.showTime === next.showTime &&
		previous.checkable === next.checkable &&
		previous.selected === next.selected &&
		previous.editing === next.editing,
);
