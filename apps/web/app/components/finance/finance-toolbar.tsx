import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
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
	type DateRange,
	formatLocalDate,
	formatPeriodLabel,
	nextLocalDay,
	previousLocalDay,
} from '@web/lib/finance';
import {
	CalendarOffIcon,
	CalendarRangeIcon,
	PlusIcon,
	RepeatIcon,
	SearchIcon,
	TagIcon,
	XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';

/**
 * Sticky, because the payment worth adding usually occurs to you while reading
 * the list, and scrolling back to the top to reach the button is the whole
 * friction. The shell's own header is not sticky, so this pins to the viewport.
 *
 * Two rows on a phone rather than three — a bar that stays on screen has to
 * earn its height. Row one is the period and the one action; row two is the
 * two filters. On `md` the same four groups reflow into a single row, ordered
 * period, filters, then actions pushed right. Letting `flex-wrap` decide the
 * mobile layout produced a ragged staircase of right-aligned fragments.
 */
export function FinanceToolbar({
	query,
	range,
	selectedTags,
	subscriptions,
	onQueryChange,
	onRangeChange,
	onClearTags,
	onSubscriptionsChange,
	onCreate,
}: {
	query: string;
	range: DateRange;
	selectedTags: string[];
	subscriptions: boolean;
	onQueryChange: (value: string) => void;
	onRangeChange: (range: DateRange) => void;
	onClearTags: () => void;
	onSubscriptionsChange: (on: boolean) => void;
	onCreate: () => void;
}) {
	// Explicit ids rather than wrapping the input: `Input` is a component, so a
	// wrapping label associates with nothing that a screen reader can follow.
	const fromId = useId();
	const toId = useId();

	// An inverted pick is refused, but never in silence: the input snaps back
	// to the applied range, so without this line nothing would say why. Inline
	// rather than a toast because the condition stays true until it is fixed.
	const [inverted, setInverted] = useState(false);

	// The inclusive end the url and the date inputs both speak. By calendar
	// components, not ±24h: a DST day is not 86 400 000 ms long.
	const inclusiveEnd =
		range.toExclusive === null ? null : previousLocalDay(range.toExclusive);

	/** An emptied input clears that side rather than being ignored. */
	function setBound(which: 'from' | 'to', value: string) {
		let at: number | null = null;
		if (value) {
			const [year, month, date] = value.split('-').map(Number);
			const parsed = new Date(year, month - 1, date).getTime();
			if (Number.isNaN(parsed)) return;
			at = which === 'to' ? nextLocalDay(parsed) : parsed;
		}

		const next =
			which === 'from'
				? { from: at, toExclusive: range.toExclusive }
				: { from: range.from, toExclusive: at };
		if (
			next.from !== null &&
			next.toExclusive !== null &&
			next.from >= next.toExclusive
		) {
			setInverted(true);
			return;
		}
		setInverted(false);
		onRangeChange(next);
	}

	return (
		// Bled to the section's edges so the content scrolling underneath is
		// covered all the way across, not just inside the padding.
		<div className="-mx-4 -mt-4 sm:-mx-6 sm:-mt-6 sticky top-16 z-20 flex flex-col gap-2 border-b bg-background px-4 pt-4 pb-3 sm:px-6 sm:pt-6 md:flex-row md:flex-wrap md:items-center">
			{/* Row one on a phone; on `md` the two halves become siblings. */}
			<div className="flex items-center gap-2 md:contents">
				<Popover>
					<PopoverTrigger
						render={
							<Button
								variant="outline"
								className="min-h-11 min-w-0 flex-1 justify-start md:min-h-9 md:flex-none"
							>
								<CalendarRangeIcon data-icon="inline-start" />
								{/* Prose, not a figure, so it keeps the UI face — and it
								    truncates rather than shoving the toolbar off a phone. */}
								<span className="truncate">{formatPeriodLabel(range)}</span>
							</Button>
						}
					/>
					<PopoverContent className="w-72">
						<PopoverHeader>
							<PopoverTitle>Period</PopoverTitle>
						</PopoverHeader>
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1 text-sm">
								<label htmlFor={fromId}>From</label>
								<div className="flex items-center gap-1">
									<Input
										id={fromId}
										type="date"
										className="flex-1"
										value={
											range.from === null ? '' : formatLocalDate(range.from)
										}
										onChange={(event) => setBound('from', event.target.value)}
									/>
									{/*
									 * An explicit way to empty the field: a native date input is
									 * awkward to clear with a keyboard and the mobile OS picker
									 * often offers no way at all, which would make "optional"
									 * true only in theory.
									 */}
									{range.from !== null ? (
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Clear the start date"
											onClick={() => setBound('from', '')}
										>
											<XIcon />
										</Button>
									) : null}
								</div>
							</div>
							<div className="flex flex-col gap-1 text-sm">
								<label htmlFor={toId}>To</label>
								<div className="flex items-center gap-1">
									<Input
										id={toId}
										type="date"
										className="flex-1"
										value={
											inclusiveEnd === null ? '' : formatLocalDate(inclusiveEnd)
										}
										onChange={(event) => setBound('to', event.target.value)}
									/>
									{inclusiveEnd !== null ? (
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Clear the end date"
											onClick={() => setBound('to', '')}
										>
											<XIcon />
										</Button>
									) : null}
								</div>
							</div>
							{inverted ? (
								<p role="alert" className="text-destructive text-xs">
									The start has to be on or before the end, so that pick was not
									applied.
								</p>
							) : null}

							<p className="text-muted-foreground text-xs">
								Both dates are included, and either can be left empty to leave
								that side open. Whatever you pick is remembered, so Finance
								opens on it next time.
							</p>

							{range.from !== null || range.toExclusive !== null ? (
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										onRangeChange({ from: null, toExclusive: null })
									}
								>
									<CalendarOffIcon data-icon="inline-start" /> Show all time
								</Button>
							) : null}
						</div>
					</PopoverContent>
				</Popover>

				<div className="flex shrink-0 items-center gap-2 md:order-3 md:ml-auto">
					{/*
					 * Tags are filtered from the breakdown rows, where each tag is
					 * already named next to what it cost, so all that is needed here is
					 * a way out of the filter.
					 */}
					{selectedTags.length > 0 ? (
						<Button
							variant="secondary"
							className="min-h-11 min-w-0 md:min-h-9"
							onClick={onClearTags}
						>
							<TagIcon data-icon="inline-start" />
							<span className="truncate">{selectedTags.join(', ')}</span>
							<XIcon data-icon="inline-end" />
						</Button>
					) : null}

					{/*
					 * The label appears only once there is room for it, and the key with
					 * it: a hint nobody can read is width spent on nothing, and the
					 * shortcut is of no use on the phone that hides it either way. It
					 * stays announced through `aria-keyshortcuts` at every width.
					 */}
					<Button
						onClick={onCreate}
						aria-label="Add payment"
						aria-keyshortcuts="A"
						className="size-11 shrink-0 sm:size-auto sm:min-h-11 md:min-h-9"
					>
						<PlusIcon data-icon="inline-start" />
						<span className="hidden sm:inline">Add payment</span>
						<Kbd className="hidden lg:inline-flex">A</Kbd>
					</Button>
				</div>
			</div>

			{/* Row two on a phone: the two filters, which belong together. */}
			<div className="flex items-center gap-2 md:order-2 md:min-w-0 md:flex-1">
				<InputGroup className="min-w-0 flex-1 md:max-w-sm">
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						value={query}
						placeholder="Search payments…"
						aria-label="Search payments by title or tag"
						onChange={(event) => onQueryChange(event.target.value)}
					/>
					{query ? (
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								aria-label="Clear payment search"
								onClick={() => onQueryChange('')}
							>
								<XIcon />
							</InputGroupButton>
						</InputGroupAddon>
					) : null}
				</InputGroup>

				<Toggle
					pressed={subscriptions}
					onPressedChange={onSubscriptionsChange}
					variant="outline"
					className="min-h-11 shrink-0 md:min-h-9"
					aria-label="Show recurring subscriptions"
				>
					<RepeatIcon data-icon="inline-start" />
					Recurring
				</Toggle>
			</div>
		</div>
	);
}
