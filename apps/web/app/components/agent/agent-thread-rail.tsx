import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { Spinner } from '@web/components/ui/spinner';
import type { AgentThread } from '@web/lib/agent-api';
import { cn } from '@web/lib/utils';
import {
	EllipsisVerticalIcon,
	ListChecksIcon,
	PanelLeftCloseIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Long enough that a burst of keystrokes is one request, short enough to feel live. */
const QUERY_DEBOUNCE_MS = 150;

/**
 * Fetch the next page before the last row is on screen: the rail is short, so
 * hitting the true bottom would always show a spinner.
 */
const LOAD_MORE_MARGIN = '200px';
/**
 * The rail is the only thing that grows a selection, so it owns the ceiling and
 * reports reaching it through `onSelectionLimit`. Exported so the message that
 * names the number cannot drift from the number.
 */
export const MAX_BULK_SELECTION = 100;

/**
 * The master of the master–detail: navigation chrome, like the shell's
 * sidebar, so its internal scroll is legitimate — the document scroller
 * belongs to the conversation. The same component fills the desktop rail and
 * the mobile sheet.
 *
 * The index is paginated and searched server-side, so the rail owns neither
 * filter nor page: it reports intent (`onQueryChange`, `onLoadMore`) and
 * renders whatever the store hands back.
 */
export function AgentThreadRail({
	threads,
	loading,
	loadingMore,
	loadMoreError,
	hasMore,
	error,
	query,
	selectedId,
	selected = new Set<string>(),
	generatingTitleId,
	titleActionBusy = false,
	interactionBusy = false,
	onSelect,
	onNew,
	onRetry,
	onRename,
	onDelete,
	onGenerateTitle,
	onSelectionChange,
	onSelectionLimit,
	onDeleteSelected,
	onLoadMore,
	onQueryChange,
	onCollapse,
	reserveCloseSpace = false,
}: {
	threads: AgentThread[];
	/** The first page is in flight: nothing to show yet. */
	loading: boolean;
	/** A further page is in flight: the list stays, the tail says so. */
	loadingMore: boolean;
	/** A failed tail page pauses automatic observation until explicit retry. */
	loadMoreError?: string;
	hasMore: boolean;
	error?: string;
	/** The title filter in force, owned by the store. */
	query: string;
	selectedId?: string;
	selected?: ReadonlySet<string>;
	generatingTitleId?: string;
	titleActionBusy?: boolean;
	interactionBusy?: boolean;
	onSelect: (id: string) => void;
	onNew: () => void;
	onRetry: () => void;
	onRename: (thread: AgentThread) => void;
	onDelete: (thread: AgentThread) => void;
	onGenerateTitle: (thread: AgentThread) => void;
	onSelectionChange: (selected: Set<string>) => void;
	onSelectionLimit: () => void;
	onDeleteSelected: () => void;
	onLoadMore: () => void;
	onQueryChange: (query: string) => void;
	/** Folds the desktop rail away; absent inside the mobile sheet. */
	onCollapse?: () => void;
	/** Inside the sheet, the overlay's own close button owns the top-right. */
	reserveCloseSpace?: boolean;
}) {
	const [text, setText] = useState(query);
	const selectionMode = selected.size > 0;
	const anchorRef = useRef<string | undefined>(undefined);
	if (!anchorRef.current || !selected.has(anchorRef.current)) {
		anchorRef.current = threads.findLast((thread) =>
			selected.has(thread.id),
		)?.id;
	}

	function selectOnly(id: string) {
		if (interactionBusy || generatingTitleId !== undefined) return;
		anchorRef.current = id;
		onSelectionChange(new Set([id]));
	}

	function toggleSelected(id: string) {
		if (interactionBusy || generatingTitleId !== undefined) return;
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else if (next.size < MAX_BULK_SELECTION) next.add(id);
		else {
			onSelectionLimit();
			return;
		}
		anchorRef.current = next.has(id)
			? id
			: threads.findLast((thread) => next.has(thread.id))?.id;
		onSelectionChange(next);
	}

	function selectRange(id: string) {
		if (interactionBusy || generatingTitleId !== undefined) return;
		const anchor = anchorRef.current;
		if (!anchor) {
			selectOnly(id);
			return;
		}
		const start = threads.findIndex((thread) => thread.id === anchor);
		const end = threads.findIndex((thread) => thread.id === id);
		if (start < 0 || end < 0) return;
		const next = new Set(selected);
		for (const thread of threads.slice(
			Math.min(start, end),
			Math.max(start, end) + 1,
		)) {
			if (next.size >= MAX_BULK_SELECTION) {
				onSelectionLimit();
				break;
			}
			next.add(thread.id);
		}
		onSelectionChange(next);
	}

	/**
	 * The last value this rail and the store agreed on. Comparing against it
	 * instead of against `query` is what lets a debounced commit land while the
	 * person keeps typing: the prop catching up to a value we sent is not an
	 * outside change, so it must not clobber the newer keystrokes.
	 */
	const settled = useRef(query);
	if (query !== settled.current) {
		settled.current = query;
		setText(query);
	}

	// Kept in a ref so a parent that re-renders with a fresh callback does not
	// restart the debounce — only a keystroke should.
	const onQueryChangeRef = useRef(onQueryChange);
	onQueryChangeRef.current = onQueryChange;

	useEffect(() => {
		if (text === settled.current) return;
		const timeout = window.setTimeout(() => {
			settled.current = text;
			onQueryChangeRef.current(text);
		}, QUERY_DEBOUNCE_MS);
		return () => window.clearTimeout(timeout);
	}, [text]);

	function clearQuery() {
		settled.current = '';
		setText('');
		onQueryChange('');
	}

	const scrollRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const onLoadMoreRef = useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;

	/**
	 * The rail scrolls internally, so the observer's root is that container and
	 * not the viewport — against the viewport the sentinel of a scrolled-away
	 * list reads as visible (or never does) and the pagination stalls.
	 */
	useEffect(() => {
		if (!hasMore || loadingMore || loadMoreError) return;
		const root = scrollRef.current;
		const sentinel = sentinelRef.current;
		if (!root || !sentinel) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					onLoadMoreRef.current();
				}
			},
			{ root, rootMargin: LOAD_MORE_MARGIN },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, loadingMore, loadMoreError]);

	const searching = query.trim().length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/*
			 * `h-16` matches the shell's header, so the rail's first row lines up
			 * with the breadcrumb on desktop — and, inside the sheet, with the
			 * overlay's close button, which sits at a fixed `top-4` and is
			 * centred on exactly this height.
			 */}
			<div
				className={cn(
					'flex h-16 shrink-0 items-center justify-between gap-2 px-4',
					reserveCloseSpace && 'pr-14',
				)}
			>
				{selectionMode ? (
					<div className="flex min-w-0 items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							disabled={interactionBusy}
							onClick={() => onSelectionChange(new Set())}
							aria-label="Clear selection"
						>
							<XIcon aria-hidden="true" /> {selected.size} selected
						</Button>
						<Button
							variant="destructive"
							size="sm"
							disabled={interactionBusy}
							onClick={onDeleteSelected}
							aria-label={`Delete ${selected.size}`}
						>
							<Trash2Icon aria-hidden="true" /> Delete {selected.size}
						</Button>
					</div>
				) : (
					<h2 className="font-medium text-muted-foreground text-sm">
						Conversations
					</h2>
				)}
				<div className="flex items-center gap-1">
					{!selectionMode && (
						<Button
							variant="outline"
							size="sm"
							className="max-sm:h-11"
							onClick={onNew}
							disabled={interactionBusy}
							aria-keyshortcuts="n"
						>
							<PlusIcon aria-hidden="true" />
							New chat
						</Button>
					)}
					{onCollapse && !selectionMode && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="max-lg:hidden"
							onClick={onCollapse}
							aria-label="Collapse conversations"
							aria-keyshortcuts="Control+Alt+B"
						>
							<PanelLeftCloseIcon aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			<div className="shrink-0 px-4 pb-3">
				<InputGroup className="h-11 bg-input/20 lg:h-9">
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						type="search"
						value={text}
						placeholder="Search conversations…"
						aria-label="Search conversations by title"
						onChange={(event) => setText(event.target.value)}
					/>
					{text ? (
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-sm"
								aria-label="Clear conversation search"
								onClick={clearQuery}
							>
								<XIcon />
							</InputGroupButton>
						</InputGroupAddon>
					) : null}
				</InputGroup>
			</div>

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
				{loading && threads.length === 0 ? (
					<div className="flex flex-col gap-2 px-2 py-1">
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-4/5" />
						<Skeleton className="h-8 w-full" />
					</div>
				) : error && threads.length === 0 ? (
					<div className="flex flex-col items-start gap-2 px-2 py-1 text-sm">
						<p className="text-muted-foreground">{error}</p>
						<Button variant="outline" size="sm" onClick={onRetry}>
							Try again
						</Button>
					</div>
				) : threads.length === 0 ? (
					/*
					 * An empty index and an empty result set are different problems:
					 * one needs a first chat, the other needs the filter gone.
					 */
					searching ? (
						<div className="flex flex-col items-start gap-2 px-2 py-1 text-sm">
							<p className="text-muted-foreground">
								No conversation titles match “{query}”.
							</p>
							<Button
								variant="outline"
								size="sm"
								className="max-lg:min-h-11"
								onClick={clearQuery}
							>
								Clear search
							</Button>
						</div>
					) : (
						<p className="px-2 py-1 text-muted-foreground text-sm">
							No conversations yet.
						</p>
					)
				) : (
					<>
						<ul className="flex flex-col gap-0.5">
							{threads.map((thread) => {
								/**
								 * Generating a title is a whole LLM round trip, so the row
								 * it belongs to says it is working — the same icon-for-
								 * spinner swap the compact button makes. Without comparing
								 * the id, `generatingTitleId` disabled every row's
								 * mutations while marking none as the one in flight.
								 */
								const generating = generatingTitleId === thread.id;
								return (
									<li
										key={thread.id}
										className="group/thread relative flex items-center"
									>
										{selectionMode ? (
											<Checkbox
												checked={selected.has(thread.id)}
												disabled={interactionBusy}
												onCheckedChange={() => toggleSelected(thread.id)}
												aria-label={`Select ${thread.title}`}
												className="ml-2"
											/>
										) : null}
										<button
											type="button"
											disabled={interactionBusy}
											onClick={(event) => {
												if (event.shiftKey) selectRange(thread.id);
												else onSelect(thread.id);
											}}
											aria-current={
												thread.id === selectedId ? 'true' : undefined
											}
											aria-busy={generating || undefined}
											className={cn(
												'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-10 text-left text-sm lg:min-h-9',
												thread.id === selectedId
													? 'bg-muted font-medium'
													: 'hover:bg-muted/60',
											)}
										>
											<span className="truncate" title={thread.title}>
												{thread.title}
											</span>
											{/* `aria-busy` above is what the row says out
											    loud; this is its visible half. */}
											{generating && (
												<Spinner
													aria-hidden="true"
													className="size-4 shrink-0"
												/>
											)}
										</button>

										{!selectionMode && (
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															type="button"
															variant="ghost"
															size="icon"
															className="-translate-y-1/2 absolute top-1/2 right-1 size-8 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/thread:opacity-100 data-popup-open:opacity-100 max-lg:opacity-100"
															aria-label={`Actions for ${thread.title}`}
															disabled={interactionBusy}
														/>
													}
												>
													<EllipsisVerticalIcon aria-hidden="true" />
												</DropdownMenuTrigger>
												<DropdownMenuContent align="start">
													<DropdownMenuGroup>
														<DropdownMenuItem
															disabled={generatingTitleId !== undefined}
															onClick={() => selectOnly(thread.id)}
														>
															<ListChecksIcon aria-hidden="true" /> Select
														</DropdownMenuItem>
														<DropdownMenuItem
															disabled={
																titleActionBusy ||
																generatingTitleId !== undefined
															}
															onClick={() => onGenerateTitle(thread)}
														>
															{/*
															 * Reopening the menu of the row in flight has to find the
															 * action where it was left, in the tense the dialogs
															 * already use for their busy labels.
															 */}
															{generating ? (
																<>
																	<Spinner
																		aria-hidden="true"
																		className="size-4"
																	/>{' '}
																	Generating title…
																</>
															) : (
																<>
																	<SparklesIcon aria-hidden="true" /> Generate
																	title
																</>
															)}
														</DropdownMenuItem>
														<DropdownMenuItem
															disabled={generatingTitleId !== undefined}
															onClick={() => onRename(thread)}
														>
															<PencilIcon aria-hidden="true" /> Rename
														</DropdownMenuItem>
														<DropdownMenuItem
															variant="destructive"
															disabled={generatingTitleId !== undefined}
															onClick={() => onDelete(thread)}
														>
															<Trash2Icon aria-hidden="true" /> Delete
														</DropdownMenuItem>
													</DropdownMenuGroup>
												</DropdownMenuContent>
											</DropdownMenu>
										)}
									</li>
								);
							})}
						</ul>

						{hasMore && <div ref={sentinelRef} aria-hidden="true" />}

						{loadingMore && (
							<div className="flex justify-center py-3 text-muted-foreground">
								<Spinner aria-label="Loading more conversations" />
							</div>
						)}

						{loadMoreError && (
							<div className="flex flex-col items-center gap-2 py-3 text-center text-sm">
								<p className="text-muted-foreground">{loadMoreError}</p>
								<Button variant="outline" size="sm" onClick={onLoadMore}>
									Try loading more
								</Button>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
