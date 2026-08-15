import { CalendarQuickAdd } from '@web/components/calendar/calendar-quick-add';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Input } from '@web/components/ui/input';
import { Kbd } from '@web/components/ui/kbd';
import {
	Popover,
	PopoverContent,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { Toggle } from '@web/components/ui/toggle';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
	type CalendarDayGroup,
	formatShortDate,
	type QuickAddParse,
} from '@web/lib/calendar';
import {
	CalendarRangeIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	EyeIcon,
	KeyboardIcon,
	PanelRightIcon,
	RefreshCwIcon,
	SearchIcon,
	TagIcon,
	Trash2Icon,
	XIcon,
} from 'lucide-react';
import { type Ref, useId, useState } from 'react';

/**
 * The tag filter: every tag in use, checked while visible. Unchecking hides
 * the tag's events everywhere — days, schedule, backlog — and the choice is
 * shared across devices with the rest of the view settings.
 */
function TagFilter({
	tags,
	hiddenTags,
	hideUntagged,
	onToggleTag,
	onToggleUntagged,
	triggerRef,
}: {
	tags: string[];
	hiddenTags: string[];
	hideUntagged: boolean;
	onToggleTag: (tag: string) => void;
	onToggleUntagged: () => void;
	/** `f` lands here from anywhere on the screen. */
	triggerRef: Ref<HTMLButtonElement> | undefined;
}) {
	const hiddenCount = tags.filter((tag) =>
		hiddenTags.some(
			(hidden) => hidden.toLocaleLowerCase() === tag.toLocaleLowerCase(),
		),
	).length;

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						ref={triggerRef}
						variant="ghost"
						size="icon-sm"
						aria-label="Filter tags"
						aria-keyshortcuts="f"
						className={
							hiddenCount > 0 || hideUntagged
								? 'text-foreground'
								: 'text-muted-foreground'
						}
					>
						<TagIcon />
					</Button>
				}
			/>
			<PopoverContent align="end" className="w-56">
				<PopoverHeader>
					<PopoverTitle>Tags</PopoverTitle>
				</PopoverHeader>
				{tags.length > 0 ? (
					<ul className="flex flex-col gap-2 pt-2">
						{/* The untagged residue, toggleable like any chip. */}
						<li className="flex items-center gap-2 text-sm">
							<Checkbox
								id="tag-untagged"
								checked={!hideUntagged}
								aria-label="Show untagged"
								onCheckedChange={onToggleUntagged}
							/>
							<label htmlFor="tag-untagged" className="text-muted-foreground">
								Untagged
							</label>
						</li>
						{tags.map((tag) => {
							const visible = !hiddenTags.some(
								(hidden) =>
									hidden.toLocaleLowerCase() === tag.toLocaleLowerCase(),
							);
							return (
								<li key={tag} className="flex items-center gap-2 text-sm">
									<Checkbox
										id={`tag-${tag}`}
										checked={visible}
										aria-label={`Show ${tag}`}
										onCheckedChange={() => onToggleTag(tag)}
									/>
									<label htmlFor={`tag-${tag}`}>{tag}</label>
								</li>
							);
						})}
					</ul>
				) : (
					<p className="pt-2 text-muted-foreground text-sm">
						Tag an event from its dialog and it shows up here.
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}

/**
 * Custom day groups — the coming weekend plus its holiday Monday read as one
 * bucket. Declared as plain ranges, removable one by one; the view merges
 * whatever the window overlaps.
 */
function GroupEditor({
	groups,
	onAddGroup,
	onRemoveGroup,
}: {
	groups: CalendarDayGroup[];
	onAddGroup: (group: CalendarDayGroup) => void;
	onRemoveGroup: (index: number) => void;
}) {
	const fromId = useId();
	const toId = useId();
	const labelId = useId();
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [label, setLabel] = useState('');

	const valid = from !== '' && to !== '' && from <= to;

	function add() {
		if (!valid) return;
		onAddGroup(label.trim() ? { from, to, label: label.trim() } : { from, to });
		setFrom('');
		setTo('');
		setLabel('');
	}

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Group days"
						className={
							groups.length > 0 ? 'text-foreground' : 'text-muted-foreground'
						}
					>
						<CalendarRangeIcon />
					</Button>
				}
			/>
			<PopoverContent align="end" className="w-72">
				<PopoverHeader>
					<PopoverTitle>Grouped days</PopoverTitle>
				</PopoverHeader>
				<div className="flex flex-col gap-3 pt-2">
					{groups.length > 0 ? (
						<ul className="flex flex-col gap-1.5">
							{groups.map((group, index) => (
								<li
									key={`${group.from}:${group.to}`}
									className="flex items-center gap-2 text-sm"
								>
									<span className="min-w-0 flex-1 truncate">
										{group.label ? `${group.label} · ` : ''}
										<span className="font-mono text-xs tabular-nums">
											{formatShortDate(group.from)}–{formatShortDate(group.to)}
										</span>
									</span>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Ungroup ${formatShortDate(group.from)}–${formatShortDate(group.to)}`}
										onClick={() => onRemoveGroup(index)}
									>
										<Trash2Icon />
									</Button>
								</li>
							))}
						</ul>
					) : null}
					<div className="flex flex-col gap-2 text-sm">
						<div className="flex items-end gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<label htmlFor={fromId}>From</label>
								<Input
									id={fromId}
									type="date"
									value={from}
									onChange={(event) => setFrom(event.target.value)}
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<label htmlFor={toId}>To</label>
								<Input
									id={toId}
									type="date"
									value={to}
									onChange={(event) => setTo(event.target.value)}
								/>
							</div>
						</div>
						<div className="flex items-end gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<label htmlFor={labelId}>Label</label>
								<Input
									id={labelId}
									value={label}
									placeholder="optional"
									onChange={(event) => setLabel(event.target.value)}
								/>
							</div>
							<Button size="sm" disabled={!valid} onClick={add}>
								Group
							</Button>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * Sticky, because the thing worth adding usually occurs to you while reading
 * the days — which is exactly why the quick-add line lives here, one line for
 * the whole screen instead of one per bucket. Two rows on a phone; on `md`
 * the quick-add takes the middle of a single row.
 */
export function CalendarToolbar({
	window: week,
	offset,
	refreshing,
	showDone,
	panelOpen,
	today,
	tags,
	hiddenTags,
	hideUntagged,
	groups,
	tagButtonRef,
	onOffsetChange,
	onRefresh,
	onShowDoneChange,
	onPanelToggle,
	onToggleTag,
	onToggleUntagged,
	onAddGroup,
	onRemoveGroup,
	onQuickAdd,
	onTabOut,
	onHelp,
	addRef,
	searchOpen,
	searchQuery,
	searchRef,
	onSearchChange,
	onSearchClose,
}: {
	window: { start: string; end: string };
	offset: number;
	refreshing: boolean;
	showDone: boolean;
	panelOpen: boolean;
	today: string;
	tags: string[];
	hiddenTags: string[];
	hideUntagged: boolean;
	groups: CalendarDayGroup[];
	tagButtonRef: Ref<HTMLButtonElement>;
	onOffsetChange: (offset: number) => void;
	onRefresh: () => void;
	onShowDoneChange: (show: boolean) => void;
	onPanelToggle: () => void;
	onToggleTag: (tag: string) => void;
	onToggleUntagged: () => void;
	onAddGroup: (group: CalendarDayGroup) => void;
	onRemoveGroup: (index: number) => void;
	onQuickAdd: (parsed: QuickAddParse) => void;
	/** Tab in the add line lands on the first row, not on the filter icons. */
	onTabOut: () => void;
	onHelp: () => void;
	searchOpen: boolean;
	searchQuery: string;
	searchRef: Ref<HTMLInputElement>;
	onSearchChange: (query: string) => void;
	onSearchClose: () => void;
	/** The bare `a` lands the caret here from anywhere on the screen. */
	addRef: Ref<HTMLTextAreaElement>;
}) {
	return (
		// Bled to the section's edges so the content scrolling underneath is
		// covered all the way across, not just inside the padding.
		<div className="-mx-4 -mt-4 sm:-mx-6 sm:-mt-6 sticky top-16 z-20 flex flex-col gap-2 border-b bg-background px-4 pt-4 pb-3 sm:px-6 sm:pt-6 md:flex-row md:flex-wrap md:items-center">
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Previous week"
					onClick={() => onOffsetChange(offset - 1)}
				>
					<ChevronLeftIcon />
				</Button>
				<span className="min-w-0 truncate font-mono text-sm tabular-nums">
					{formatShortDate(week.start)} – {formatShortDate(week.end)}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Next week"
					onClick={() => onOffsetChange(offset + 1)}
				>
					<ChevronRightIcon />
				</Button>
				{offset !== 0 ? (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Back to today"
						onClick={() => onOffsetChange(0)}
					>
						<XIcon />
					</Button>
				) : null}

				{/* On a phone this row also carries the icons, pushed right. */}
				<div className="ml-auto flex items-center gap-1 md:hidden">
					<ToolbarIcons
						refreshing={refreshing}
						showDone={showDone}
						panelOpen={panelOpen}
						tags={tags}
						hiddenTags={hiddenTags}
						hideUntagged={hideUntagged}
						groups={groups}
						tagButtonRef={undefined}
						onToggleUntagged={onToggleUntagged}
						onRefresh={onRefresh}
						onShowDoneChange={onShowDoneChange}
						onPanelToggle={onPanelToggle}
						onToggleTag={onToggleTag}
						onAddGroup={onAddGroup}
						onRemoveGroup={onRemoveGroup}
						onHelp={onHelp}
					/>
				</div>
			</div>

			<div className="flex min-w-0 flex-1 items-start gap-2">
				<CalendarQuickAdd
					ref={addRef}
					today={today}
					onAdd={onQuickAdd}
					onTabOut={onTabOut}
				/>
			</div>

			<div className="hidden items-center gap-1 md:flex">
				<ToolbarIcons
					refreshing={refreshing}
					showDone={showDone}
					panelOpen={panelOpen}
					tags={tags}
					hiddenTags={hiddenTags}
					hideUntagged={hideUntagged}
					groups={groups}
					tagButtonRef={tagButtonRef}
					onToggleUntagged={onToggleUntagged}
					onRefresh={onRefresh}
					onShowDoneChange={onShowDoneChange}
					onPanelToggle={onPanelToggle}
					onToggleTag={onToggleTag}
					onAddGroup={onAddGroup}
					onRemoveGroup={onRemoveGroup}
					onHelp={onHelp}
				/>
			</div>
			{searchOpen ? (
				<div className="flex w-full items-center gap-2 md:order-last md:basis-full">
					<SearchIcon
						aria-hidden
						className="size-4 shrink-0 text-muted-foreground"
					/>
					{/* Finds across everything on purpose: done, hidden tags and the
					    folded panel are all overruled while a query is alive. */}
					<input
						ref={searchRef}
						type="text"
						aria-label="Find events"
						placeholder="Find…"
						value={searchQuery}
						onChange={(event) => onSearchChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								onSearchClose();
							}
						}}
						className="h-8 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
					/>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Close search"
						onClick={onSearchClose}
					>
						<XIcon />
					</Button>
				</div>
			) : null}
		</div>
	);
}

function ToolbarIcons({
	refreshing,
	showDone,
	panelOpen,
	tags,
	hiddenTags,
	hideUntagged,
	groups,
	tagButtonRef,
	onToggleUntagged,
	onRefresh,
	onShowDoneChange,
	onPanelToggle,
	onToggleTag,
	onAddGroup,
	onRemoveGroup,
	onHelp,
}: {
	refreshing: boolean;
	showDone: boolean;
	panelOpen: boolean;
	tags: string[];
	hiddenTags: string[];
	hideUntagged: boolean;
	groups: CalendarDayGroup[];
	tagButtonRef: Ref<HTMLButtonElement> | undefined;
	onRefresh: () => void;
	onShowDoneChange: (show: boolean) => void;
	onPanelToggle: () => void;
	onToggleTag: (tag: string) => void;
	onToggleUntagged: () => void;
	onAddGroup: (group: CalendarDayGroup) => void;
	onRemoveGroup: (index: number) => void;
	onHelp: () => void;
}) {
	return (
		<>
			<TagFilter
				tags={tags}
				hiddenTags={hiddenTags}
				hideUntagged={hideUntagged}
				onToggleTag={onToggleTag}
				onToggleUntagged={onToggleUntagged}
				triggerRef={tagButtonRef}
			/>
			<GroupEditor
				groups={groups}
				onAddGroup={onAddGroup}
				onRemoveGroup={onRemoveGroup}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<Toggle
							size="sm"
							pressed={showDone}
							onPressedChange={onShowDoneChange}
							aria-label="Show done"
							className="text-muted-foreground aria-pressed:text-foreground"
						>
							<EyeIcon />
						</Toggle>
					}
				/>
				<TooltipContent>
					{showDone ? 'Hide what is done' : 'Show what is done'}
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						// Only meaningful where the column exists; below `lg` the
						// backlog and schedule are inline sections, not a panel.
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Toggle side panel"
							aria-pressed={panelOpen}
							aria-keyshortcuts="Control+Alt+B"
							onClick={onPanelToggle}
							className="hidden text-muted-foreground lg:inline-flex"
						>
							<PanelRightIcon />
						</Button>
					}
				/>
				<TooltipContent>
					Backlog & Schedule <Kbd>Ctrl+Alt+B</Kbd>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Refresh"
							disabled={refreshing}
							onClick={onRefresh}
						>
							<RefreshCwIcon
								className={refreshing ? 'animate-spin' : undefined}
							/>
						</Button>
					}
				/>
				<TooltipContent>Refresh from the server</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Keys and grammar"
							aria-keyshortcuts="?"
							onClick={onHelp}
							className="text-muted-foreground"
						>
							<KeyboardIcon />
						</Button>
					}
				/>
				<TooltipContent>
					Keys & grammar <Kbd>?</Kbd>
				</TooltipContent>
			</Tooltip>
		</>
	);
}
