import { Button } from '@web/components/ui/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { Spinner } from '@web/components/ui/spinner';
import { SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export type ThreadFinderMatch = {
	id: string;
	position: number;
	role: string;
	snippet: string;
};

/** Long enough that a word costs one request, short enough to feel typed-through. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The two roles a conversation actually has, in the vocabulary the screen uses
 * elsewhere. Anything else is title-cased rather than left raw, so a transcript
 * that grows a role still reads as a speaker instead of an identifier.
 */
function speakerLabel(role: string) {
	if (role === 'user') return 'You';
	if (role === 'assistant') return 'Agent';
	return role.charAt(0).toUpperCase() + role.slice(1) || 'Unknown';
}

/**
 * Arrow keys move DOM focus between the result buttons instead of faking a
 * listbox: the rows are actions (jump there), Enter and Space already activate
 * a focused button, and every row stays tabbable, so nothing depends on a
 * roving tabindex being kept in sync.
 */
function focusSibling(
	list: HTMLElement | null,
	from: EventTarget,
	step: 1 | -1,
) {
	if (!list) return false;
	const rows = Array.from(
		list.querySelectorAll<HTMLButtonElement>('button[data-thread-match]'),
	);
	if (rows.length === 0) return false;
	const index = rows.indexOf(from as HTMLButtonElement);
	const next = rows[index + step];
	if (!next) return false;
	next.focus();
	return true;
}

export function AgentThreadFinder({
	onSearch,
	matches,
	searching,
	loadingMore,
	hasMore,
	error,
	onJump,
	onLoadMore,
	open: controlledOpen,
	onOpenChange,
}: {
	/** Fires with the already debounced text; '' means clear. */
	onSearch: (query: string) => void;
	matches: ThreadFinderMatch[];
	searching: boolean;
	loadingMore: boolean;
	hasMore: boolean;
	/** Failure message to show inline (no toast). */
	error?: string;
	/** The user picked a result: jump to that message. */
	onJump: (match: ThreadFinderMatch) => void;
	onLoadMore: () => void;
	/**
	 * Optional control, so a keyboard shortcut on the screen can open this.
	 * Uncontrolled — no `open` prop — it owns its own state as before.
	 */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = (next: boolean) => {
		setUncontrolledOpen(next);
		onOpenChange?.(next);
	};
	const [query, setQuery] = useState('');
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The debounce fires later than the render that scheduled it, so it reads the
	// callback from a ref instead of closing over a possibly stale prop.
	const onSearchRef = useRef(onSearch);
	onSearchRef.current = onSearch;

	const clearTimer = () => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = null;
	};

	// Inline rather than reusing `clearTimer`, so the cleanup depends on nothing
	// but the (stable) ref and never re-subscribes.
	useEffect(
		() => () => {
			if (timerRef.current !== null) clearTimeout(timerRef.current);
		},
		[],
	);

	// Opening puts the caret in the field: the popup would otherwise take focus
	// itself and cost a Tab before anyone can type.
	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const search = (next: string) => {
		setQuery(next);
		clearTimer();
		// Clearing is the signal to drop the results already on screen, so it can't
		// wait out a debounce. Whitespace alone is a clear too: it can't match.
		if (next.trim() === '') {
			onSearchRef.current('');
			return;
		}
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			onSearchRef.current(next);
		}, SEARCH_DEBOUNCE_MS);
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		// Closing discards the search: the field starts empty on every reopen and
		// whoever owns the results is told to drop them.
		if (!next) {
			clearTimer();
			setQuery('');
			onSearch('');
		}
	};

	const hint =
		query.trim() === ''
			? 'Type to search this conversation.'
			: searching
				? 'Searching…'
				: 'No messages match.';

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Search this conversation"
						aria-keyshortcuts="Control+F"
						className="text-muted-foreground max-sm:size-11"
					/>
				}
			>
				<SearchIcon aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[22rem] gap-2 p-2">
				<label className="sr-only" htmlFor={inputId}>
					Search this conversation
				</label>
				<InputGroup className="h-11">
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						ref={inputRef}
						id={inputId}
						type="search"
						placeholder="Search this conversation…"
						value={query}
						autoComplete="off"
						onChange={(event) => search(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key !== 'ArrowDown') return;
							const first = listRef.current?.querySelector<HTMLButtonElement>(
								'button[data-thread-match]',
							);
							if (!first) return;
							event.preventDefault();
							first.focus();
						}}
					/>
					<InputGroupAddon align="inline-end">
						{searching && <Spinner aria-hidden="true" />}
						{query !== '' && (
							<InputGroupButton
								size="icon-xs"
								aria-label="Clear search"
								onClick={() => {
									search('');
									inputRef.current?.focus();
								}}
							>
								<XIcon />
							</InputGroupButton>
						)}
					</InputGroupAddon>
				</InputGroup>
				{error !== undefined && (
					<p className="px-2 text-xs text-destructive">{error}</p>
				)}
				{matches.length > 0 ? (
					<ul
						ref={listRef}
						className="-mx-1 max-h-72 overflow-y-auto overscroll-contain px-1"
						onKeyDown={(event) => {
							if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
							if (!event.target) return;
							const moved = focusSibling(
								listRef.current,
								event.target,
								event.key === 'ArrowDown' ? 1 : -1,
							);
							if (moved) event.preventDefault();
						}}
					>
						{matches.map((match) => (
							<li key={match.id}>
								<button
									type="button"
									data-thread-match=""
									className="flex min-h-10 w-full flex-col gap-0.5 rounded-2xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
									onClick={() => {
										onJump(match);
										handleOpenChange(false);
									}}
								>
									<span className="text-xs font-medium text-muted-foreground">
										{speakerLabel(match.role)}
									</span>
									<span className="line-clamp-2 text-sm">{match.snippet}</span>
								</button>
							</li>
						))}
						{hasMore && (
							<li className="flex justify-center py-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={loadingMore}
									onClick={onLoadMore}
								>
									{loadingMore ? <Spinner /> : null}
									Load more matches
								</Button>
							</li>
						)}
					</ul>
				) : (
					error === undefined && (
						<p className="px-2 py-1.5 text-xs text-muted-foreground">{hint}</p>
					)
				)}
			</PopoverContent>
		</Popover>
	);
}
