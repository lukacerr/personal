import {
	CalendarBacklog,
	toBacklogItem,
} from '@web/components/calendar/calendar-backlog';
import {
	EventDeleteDialog,
	KeybindsDialog,
} from '@web/components/calendar/calendar-dialogs';
import { itemKey } from '@web/components/calendar/calendar-item';
import { CalendarSchedule } from '@web/components/calendar/calendar-schedule';
import { CalendarToolbar } from '@web/components/calendar/calendar-toolbar';
import { CalendarWeek } from '@web/components/calendar/calendar-week';
import { Spinner } from '@web/components/ui/spinner';
import {
	type AgendaItem,
	addDays,
	backlogItems,
	type CalendarDayGroup,
	collectEventTags,
	dayAgenda,
	isAddEventShortcut,
	isCloneShortcut,
	isEditSelectionShortcut,
	isFindShortcut,
	isHelpShortcut,
	isTagFilterShortcut,
	isTagHidden,
	isToggleCalendarPanelShortcut,
	isToggleDoneFilterShortcut,
	isUndoShortcut,
	matchesEventSearch,
	type QuickAddParse,
	scheduleItems,
	todayLocalDate,
	toggleDetailLine,
	weekBuckets,
	weekWindow,
} from '@web/lib/calendar';
import type { CalendarEvent } from '@web/lib/calendar-api';
import {
	readSharedCalendarSettings,
	writeSharedCalendarSettings,
} from '@web/lib/calendar-api';
import {
	calendarDb,
	createLocalEvent,
	deleteLocalEvent,
	setLocalCompletion,
	updateLocalEvent,
} from '@web/lib/calendar-db';
import {
	type CalendarSettings,
	DEFAULT_CALENDAR_SETTINGS,
	loadCalendarSettings,
	reconcileCalendarSettings,
	saveCalendarSettings,
} from '@web/lib/calendar-settings';
import {
	type CalendarRefreshResult,
	describeCalendarFailure,
	describeDiscardedSync,
	refreshCalendar,
	syncCalendarOutbox,
} from '@web/lib/calendar-sync';
import { isEditableTarget } from '@web/lib/keyboard';
import { cn } from '@web/lib/utils';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

export function meta() {
	return [{ title: 'Calendar · Personal' }];
}

/** A terminal rejection surfaces as a toast; a transient one just stays queued. */
function reportRefresh(result: CalendarRefreshResult) {
	if (result.status === 'failed') {
		toast.error(describeCalendarFailure(result));
		return;
	}
	if (result.status === 'refreshed')
		for (const failure of result.discarded)
			toast.error(describeDiscardedSync(failure));
}

/**
 * Every local write already landed in Dexie; this only pushes it out. Offline
 * is not a failure here — the outbox is the design — and a transient error
 * stays queued for the next trigger, so only terminal rejections speak.
 */
function pushChanges() {
	if (!navigator.onLine) return;
	void syncCalendarOutbox().then(
		(discarded) => {
			for (const failure of discarded)
				toast.error(describeDiscardedSync(failure));
		},
		() => {},
	);
}

const saveFailed = () => toast.error('Could not save on this device.');

export default function Calendar() {
	const [searchParams, setSearchParams] = useSearchParams();

	// Read once per mount rather than per render: a fresh date in three places
	// could straddle midnight.
	const today = useMemo(() => todayLocalDate(), []);
	const [offset, setOffset] = useState(0);
	const [deleting, setDeleting] = useState<CalendarEvent>();
	const [refreshing, setRefreshing] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	// Hidden by default: the steady state of a list you work through is that
	// what is done leaves the eye. The heading counts keep the credit.
	const [showDone, setShowDone] = useState(false);
	// Ephemeral like the app sidebar's own state, and only meaningful from
	// `lg`: below it the backlog and schedule are inline sections, not a panel.
	const [panelOpen, setPanelOpen] = useState(true);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');

	const addRef = useRef<HTMLTextAreaElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const tagButtonRef = useRef<HTMLButtonElement>(null);
	/** Which side of the screen ←/→ should return to. */
	const lastLeftKey = useRef<string | null>(null);
	const lastRightKey = useRef<string | null>(null);
	/**
	 * The sync is debounced behind rapid local edits: holding Ctrl+↓ coalesces
	 * into one patch either way, but pushing per step made every server echo
	 * re-render the screen mid-gesture. The queue keeps everything meanwhile.
	 */
	const pushTimer = useRef<number | undefined>(undefined);
	/**
	 * What Ctrl+Z rewinds: each local change pushes the closure that puts the
	 * previous state back. Bounded because an unbounded stack is a slow leak,
	 * and fifty steps is already deeper than any accidental check.
	 */
	const undoStack = useRef<Array<() => Promise<void>>>([]);

	const [settings, setSettings] = useState<CalendarSettings>(() =>
		typeof window === 'undefined'
			? DEFAULT_CALENDAR_SETTINGS
			: loadCalendarSettings(window.localStorage),
	);

	const data = useLiveQuery(async () => {
		const [events, completions] = await Promise.all([
			calendarDb.events.toArray(),
			calendarDb.completions.toArray(),
		]);
		return { events, completions };
	}, []);

	// On mount, on reconnect and on returning to the foreground; an app left
	// open and focused also gets the manual button in the toolbar.
	useEffect(() => {
		const refresh = () => {
			if (!navigator.onLine) return;
			void refreshCalendar().then(reportRefresh);
		};
		const handleVisibility = () => {
			if (document.visibilityState === 'visible') refresh();
		};

		refresh();
		window.addEventListener('online', refresh);
		document.addEventListener('visibilitychange', handleVisibility);
		return () => {
			window.removeEventListener('online', refresh);
			document.removeEventListener('visibilitychange', handleVisibility);
		};
	}, []);

	/**
	 * Adopt the shared groups and tag filter, or seed them from this device —
	 * the same one-shot reconciliation Finance runs. A change made while the
	 * answer is in flight wins, because `settled` stops it from landing on top.
	 */
	useEffect(() => {
		let settled = false;

		void readSharedCalendarSettings().then((shared) => {
			if (settled) return;
			const { settings: next, push } = reconcileCalendarSettings(
				shared,
				loadCalendarSettings(window.localStorage),
			);

			setSettings(next);
			saveCalendarSettings(window.localStorage, next);
			if (push) void writeSharedCalendarSettings(next);
		});

		return () => {
			settled = true;
		};
	}, []);

	/**
	 * The command palette can only navigate, so "Add event" arrives as `?new=1`
	 * and lands the caret on the add line — the form it used to open is gone.
	 */
	useEffect(() => {
		if (!searchParams.has('new')) return;
		addRef.current?.focus();
		setSearchParams(
			(current) => {
				const next = new URLSearchParams(current);
				next.delete('new');
				return next;
			},
			{ replace: true },
		);
	}, [searchParams, setSearchParams]);

	const week = useMemo(() => weekWindow(today, offset), [today, offset]);
	const events = data?.events ?? [];
	const completions = data?.completions ?? [];
	const hiddenTags = settings.hiddenTags ?? [];
	const hideUntagged = settings.hideUntagged ?? false;
	const groups = settings.groups ?? [];
	const searching = searchOpen && searchQuery.trim() !== '';
	// A live search overrules every filter: it answers "where is this thing",
	// and a hidden tag, a done mark or a folded panel are not answers.
	const effectiveShowDone = showDone || searching;
	const effectivePanelOpen = panelOpen || searching;

	// The tag filter cuts once, here, so no list can disagree about it.
	const visibleEvents = useMemo(() => {
		if (searching)
			return events.filter((event) => matchesEventSearch(event, searchQuery));
		return events.filter(
			(event) =>
				!isTagHidden(event, hiddenTags) && !(hideUntagged && !event.tag),
		);
	}, [events, hiddenTags, hideUntagged, searching, searchQuery]);
	const tags = useMemo(() => collectEventTags(events), [events]);

	/**
	 * The keyboard's world: every visible row, in reading order — days, then
	 * schedule, then backlog — exactly as the components lay them out.
	 */
	const ordered = useMemo(() => {
		const keep = (item: AgendaItem) =>
			effectiveShowDone || item.status !== 'done';
		const dayItems = weekBuckets(week.start, week.end, groups)
			.flatMap((bucket) =>
				bucket.dates.flatMap((date) =>
					dayAgenda(visibleEvents, completions, date),
				),
			)
			.filter(keep);
		const upcoming = (
			offset === 0 ? scheduleItems(visibleEvents, completions, week) : []
		).filter(keep);
		const waiting = backlogItems(visibleEvents).map(toBacklogItem).filter(keep);
		return {
			items: [...dayItems, ...upcoming, ...waiting],
			/** Where the side panel begins: arrows jump across this boundary. */
			dayCount: dayItems.length,
		};
	}, [visibleEvents, completions, groups, week, offset, effectiveShowDone]);
	const orderedItems = ordered.items;

	const selectedItem = useMemo(
		() => orderedItems.find((item) => itemKey(item) === selectedKey) ?? null,
		[orderedItems, selectedKey],
	);

	// Remember where each side last was, so arrows return instead of resetting.
	useEffect(() => {
		if (!selectedKey) return;
		const at = orderedItems.findIndex((item) => itemKey(item) === selectedKey);
		if (at === -1) return;
		if (at < ordered.dayCount) lastLeftKey.current = selectedKey;
		else lastRightKey.current = selectedKey;
	}, [selectedKey, orderedItems, ordered.dayCount]);

	function remember(undo: () => Promise<void>) {
		undoStack.current.push(undo);
		if (undoStack.current.length > 50) undoStack.current.shift();
	}

	function pushSoon() {
		if (pushTimer.current !== undefined) window.clearTimeout(pushTimer.current);
		pushTimer.current = window.setTimeout(pushChanges, 400);
	}

	/**
	 * The mirror is written first and synchronously: the screen has to reflect
	 * the change whether or not the cache is reachable. The shared copy is
	 * reported on, because groups that silently stayed on one device are
	 * exactly the problem sharing them was meant to solve.
	 */
	function patchSettings(changes: Partial<CalendarSettings>) {
		const next = { ...settings, ...changes };
		setSettings(next);
		saveCalendarSettings(window.localStorage, next);

		void writeSharedCalendarSettings(next).then(
			(stored) => {
				if (!stored)
					toast.error('Saved on this device only — the shared copy is down.');
			},
			() => toast.error('Saved on this device only — no connection.'),
		);
	}

	function toggleTag(tag: string) {
		const key = tag.toLocaleLowerCase();
		const hidden = hiddenTags.some(
			(entry) => entry.toLocaleLowerCase() === key,
		);
		patchSettings({
			hiddenTags: hidden
				? hiddenTags.filter((entry) => entry.toLocaleLowerCase() !== key)
				: [...hiddenTags, tag],
		});
	}

	function toggleItem(item: AgendaItem) {
		const wasDone = item.status === 'done';
		const previousCompletedAt = item.event.completedAt;
		const write = item.recurring
			? setLocalCompletion(
					calendarDb,
					item.event.id,
					item.date,
					wasDone ? null : 'done',
				)
			: updateLocalEvent(calendarDb, item.event.id, {
					completedAt: wasDone ? null : Date.now(),
				});
		write.then(() => {
			remember(() =>
				item.recurring
					? setLocalCompletion(
							calendarDb,
							item.event.id,
							item.date,
							wasDone ? 'done' : null,
						)
					: updateLocalEvent(calendarDb, item.event.id, {
							completedAt: previousCompletedAt,
						}),
			);
			pushSoon();
		}, saveFailed);
	}

	function toggleDetail(item: AgendaItem, index: number) {
		const previous = item.event.details;
		if (!previous) return;
		updateLocalEvent(calendarDb, item.event.id, {
			details: toggleDetailLine(previous, index),
		}).then(() => {
			remember(() =>
				updateLocalEvent(calendarDb, item.event.id, { details: previous }),
			);
			pushSoon();
		}, saveFailed);
	}

	/** One-offs only: a series' days are the series' own business. */
	function moveEvent(event: CalendarEvent, date: string) {
		if (event.recurrence) {
			toast.error('A series does not move whole — edit its repeat instead.');
			return;
		}
		if (event.date === null || event.date === date) return;
		const previous = event.date;
		// Optimistic on purpose: the selection jumps with the keypress, not with
		// the transaction — waiting for Dexie read as lag under a held key.
		setSelectedKey(`${event.id}:${date}`);
		updateLocalEvent(calendarDb, event.id, { date }).then(() => {
			remember(() =>
				updateLocalEvent(calendarDb, event.id, { date: previous }),
			);
			pushSoon();
		}, saveFailed);
	}

	/** A fresh copy of the selection, opened for editing right away. */
	function cloneItem(item: AgendaItem) {
		const source = item.event;
		const id = crypto.randomUUID();
		createLocalEvent(calendarDb, {
			id,
			createdAt: Date.now(),
			completedAt: null,
			title: source.title,
			details: source.details,
			tag: source.tag,
			date: source.date,
			timeMinutes: source.timeMinutes,
			recurrence: source.recurrence,
		}).then(() => {
			remember(() => deleteLocalEvent(calendarDb, id));
			const key = `${id}:${source.date ?? 'b'}`;
			setSelectedKey(key);
			setEditingKey(key);
			pushSoon();
		}, saveFailed);
	}

	function quickAdd(parsed: QuickAddParse) {
		const id = crypto.randomUUID();
		createLocalEvent(calendarDb, {
			id,
			createdAt: Date.now(),
			completedAt: null,
			title: parsed.title,
			details: parsed.details,
			tag: parsed.tag,
			date: parsed.date,
			timeMinutes: parsed.timeMinutes,
			recurrence: parsed.recurrence,
		}).then(() => {
			remember(() => deleteLocalEvent(calendarDb, id));
			pushSoon();
		}, saveFailed);
	}

	function commitEdit(event: CalendarEvent, parsed: QuickAddParse | null) {
		setEditingKey(null);
		// Submitted empty: the text is gone, so the row asks to go too.
		if (parsed === null) {
			setDeleting(event);
			return;
		}
		const previous = {
			title: event.title,
			details: event.details,
			tag: event.tag,
			date: event.date,
			timeMinutes: event.timeMinutes,
			recurrence: event.recurrence,
			completedAt: event.completedAt,
		};
		updateLocalEvent(calendarDb, event.id, {
			title: parsed.title,
			details: parsed.details,
			tag: parsed.tag,
			date: parsed.date,
			timeMinutes: parsed.timeMinutes,
			recurrence: parsed.recurrence,
			// A series has no row-level done mark; only occurrences resolve. For
			// a one-off the leading [x] is the mark, and keeps its original
			// instant when it was already there.
			completedAt:
				parsed.recurrence !== null || parsed.date === null
					? null
					: parsed.done
						? (event.completedAt ?? Date.now())
						: null,
		}).then(() => {
			remember(() => updateLocalEvent(calendarDb, event.id, previous));
			pushSoon();
		}, saveFailed);
	}

	function confirmDelete() {
		if (!deleting) return;
		const snapshot = deleting;
		const done = completions.filter((row) => row.eventId === snapshot.id);
		deleteLocalEvent(calendarDb, snapshot.id).then(
			() => {
				remember(async () => {
					await createLocalEvent(calendarDb, {
						id: snapshot.id,
						title: snapshot.title,
						details: snapshot.details,
						tag: snapshot.tag,
						date: snapshot.date,
						timeMinutes: snapshot.timeMinutes,
						recurrence: snapshot.recurrence,
						completedAt: snapshot.completedAt,
						createdAt: snapshot.createdAt,
					});
					for (const row of done)
						await setLocalCompletion(
							calendarDb,
							row.eventId,
							row.date,
							row.status,
						);
				});
				setDeleting(undefined);
				setSelectedKey(null);
				pushChanges();
			},
			() => toast.error('Could not delete on this device.'),
		);
	}

	function undo() {
		const last = undoStack.current.pop();
		if (!last) return;
		last().then(pushSoon, saveFailed);
	}

	const dialogOpen = deleting !== undefined || helpOpen;

	/**
	 * The keyboard, in one listener: bare keys select and act, chords move and
	 * undo. Everything defers to an editable target — typing owns its keys —
	 * and to open dialogs, where focus rests on buttons the keys would talk
	 * over.
	 */
	useEffect(() => {
		function onKeyDown(keyboard: KeyboardEvent) {
			if (keyboard.defaultPrevented) return;

			if (isFindShortcut(keyboard)) {
				// Claimed even inside text fields: the Tauri shell has no native
				// find, and this search is the useful answer everywhere here.
				keyboard.preventDefault();
				setSearchOpen(true);
				window.setTimeout(() => searchRef.current?.focus(), 0);
				return;
			}
			if (isToggleCalendarPanelShortcut(keyboard)) {
				keyboard.preventDefault();
				setPanelOpen((open) => !open);
				return;
			}
			if (isUndoShortcut(keyboard)) {
				keyboard.preventDefault();
				undo();
				return;
			}
			if (dialogOpen || isEditableTarget(keyboard.target)) return;

			if (isAddEventShortcut(keyboard)) {
				keyboard.preventDefault();
				addRef.current?.focus();
				return;
			}
			if (isHelpShortcut(keyboard)) {
				keyboard.preventDefault();
				setHelpOpen(true);
				return;
			}
			if (isEditSelectionShortcut(keyboard) && selectedItem) {
				keyboard.preventDefault();
				setEditingKey(itemKey(selectedItem));
				return;
			}
			if (isCloneShortcut(keyboard) && selectedItem) {
				keyboard.preventDefault();
				cloneItem(selectedItem);
				return;
			}
			if (isToggleDoneFilterShortcut(keyboard)) {
				keyboard.preventDefault();
				setShowDone((shown) => !shown);
				return;
			}
			if (isTagFilterShortcut(keyboard)) {
				keyboard.preventDefault();
				tagButtonRef.current?.click();
				return;
			}
			if (keyboard.key === 'ArrowLeft' || keyboard.key === 'ArrowRight') {
				keyboard.preventDefault();
				// Jump between the days and the side panel, returning to wherever
				// each side last was instead of resetting to its top.
				const at = orderedItems.findIndex(
					(item) => itemKey(item) === selectedKey,
				);
				const inSide = at >= ordered.dayCount;
				const toSide = keyboard.key === 'ArrowRight';
				if (toSide === inSide && at !== -1) return;
				const remembered = toSide ? lastRightKey.current : lastLeftKey.current;
				const rememberedItem = orderedItems.find(
					(item, index) =>
						itemKey(item) === remembered &&
						index >= ordered.dayCount === toSide,
				);
				const fallback = toSide
					? orderedItems[ordered.dayCount]
					: orderedItems[0];
				const target = rememberedItem ?? fallback;
				if (target) setSelectedKey(itemKey(target));
				return;
			}
			if (keyboard.key === ' ' && selectedItem && !keyboard.ctrlKey) {
				keyboard.preventDefault();
				toggleItem(selectedItem);
				return;
			}
			if (
				(keyboard.key === 'Delete' || keyboard.key === 'Backspace') &&
				selectedItem
			) {
				keyboard.preventDefault();
				setDeleting(selectedItem.event);
				return;
			}
			if (keyboard.key === 'Escape') {
				setSelectedKey(null);
				return;
			}
			if (keyboard.key !== 'ArrowDown' && keyboard.key !== 'ArrowUp') return;
			keyboard.preventDefault();
			const direction = keyboard.key === 'ArrowDown' ? 1 : -1;

			if (keyboard.ctrlKey || keyboard.metaKey) {
				// Move the selected one-off a day back or forward.
				if (selectedItem?.event.date)
					moveEvent(
						selectedItem.event,
						addDays(selectedItem.event.date, direction),
					);
				return;
			}

			if (orderedItems.length === 0) return;
			const at = orderedItems.findIndex(
				(item) => itemKey(item) === selectedKey,
			);
			const next =
				at === -1
					? direction === 1
						? 0
						: orderedItems.length - 1
					: Math.min(Math.max(at + direction, 0), orderedItems.length - 1);
			const target = orderedItems[next];
			if (target) setSelectedKey(itemKey(target));
		}

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	});

	const handlers = {
		onToggle: toggleItem,
		onToggleDetail: toggleDetail,
		onClone: cloneItem,
		onSelect: (item: AgendaItem) => setSelectedKey(itemKey(item)),
		onEdit: (item: AgendaItem) => {
			setSelectedKey(itemKey(item));
			setEditingKey(itemKey(item));
		},
		onDelete: setDeleting,
		onCommitEdit: commitEdit,
		onCancelEdit: () => setEditingKey(null),
	};

	return (
		<section
			aria-label="Calendar"
			className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6"
		>
			<CalendarToolbar
				window={week}
				offset={offset}
				refreshing={refreshing}
				showDone={showDone}
				panelOpen={panelOpen}
				today={today}
				tags={tags}
				hiddenTags={hiddenTags}
				hideUntagged={hideUntagged}
				groups={groups}
				addRef={addRef}
				tagButtonRef={tagButtonRef}
				searchOpen={searchOpen}
				searchQuery={searchQuery}
				searchRef={searchRef}
				onSearchChange={setSearchQuery}
				onSearchClose={() => {
					setSearchOpen(false);
					setSearchQuery('');
				}}
				onShowDoneChange={setShowDone}
				onPanelToggle={() => setPanelOpen((open) => !open)}
				onToggleTag={toggleTag}
				onToggleUntagged={() => patchSettings({ hideUntagged: !hideUntagged })}
				onTabOut={() => {
					const first = orderedItems[0];
					if (first) setSelectedKey(itemKey(first));
				}}
				onAddGroup={(group: CalendarDayGroup) =>
					patchSettings({ groups: [...groups, group] })
				}
				onRemoveGroup={(index: number) =>
					patchSettings({ groups: groups.filter((_, at) => at !== index) })
				}
				onQuickAdd={quickAdd}
				onHelp={() => setHelpOpen(true)}
				onOffsetChange={setOffset}
				onRefresh={() => {
					setRefreshing(true);
					void refreshCalendar()
						.then(reportRefresh)
						.finally(() => setRefreshing(false));
				}}
			/>

			{data === undefined ? (
				<div className="flex flex-1 items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
					<Spinner /> Loading calendar…
				</div>
			) : (
				/**
				 * One column on a phone — days, schedule, and the backlog last, as
				 * the least urgent thing there is. From `lg` the days take the left
				 * column and the right one stacks backlog over schedule;
				 * `grid-rows-[auto_1fr]` is what pins the schedule right under the
				 * backlog, since the first row is sized by the backlog alone.
				 */
				<div
					className={cn(
						'flex flex-col gap-4 lg:grid lg:grid-rows-[auto_1fr] lg:items-start lg:transition-[grid-template-columns,gap] lg:duration-200 motion-reduce:lg:transition-none',
						effectivePanelOpen ? 'lg:gap-6' : 'lg:gap-0',
					)}
					// Inline rather than an arbitrary-value class: the two column
					// templates interpolate through the CSS transition either way, and
					// below `lg` the container is flex, where this property is inert.
					style={{
						gridTemplateColumns: effectivePanelOpen
							? 'minmax(0,1fr) 23rem'
							: 'minmax(0,1fr) 0rem',
					}}
				>
					<div className="order-1 lg:order-none lg:col-start-1 lg:row-span-2 lg:row-start-1">
						<CalendarWeek
							window={week}
							today={today}
							events={visibleEvents}
							completions={completions}
							groups={groups}
							showDone={effectiveShowDone}
							selectedKey={selectedKey}
							editingKey={editingKey}
							onDropOnDay={(eventId, date) => {
								const event = events.find((row) => row.id === eventId);
								if (event) moveEvent(event, date);
							}}
							{...handlers}
						/>
					</div>

					<div
						className={cn(
							'order-3 min-w-0 transition-opacity duration-200 lg:order-none lg:col-start-2 lg:row-start-1 motion-reduce:transition-none',
							!effectivePanelOpen &&
								'lg:invisible lg:overflow-hidden lg:opacity-0',
						)}
					>
						<CalendarBacklog
							events={visibleEvents}
							today={today}
							selectedKey={selectedKey}
							editingKey={editingKey}
							{...handlers}
						/>
					</div>

					{/* Anchored to the current window whatever is being browsed: the
					    question it answers — what is coming — does not move with the
					    arrows. */}
					{offset === 0 ? (
						<div
							className={cn(
								'order-2 min-w-0 transition-opacity duration-200 lg:order-none lg:col-start-2 lg:row-start-2 motion-reduce:transition-none',
								!effectivePanelOpen &&
									'lg:invisible lg:overflow-hidden lg:opacity-0',
							)}
						>
							<CalendarSchedule
								events={visibleEvents}
								completions={completions}
								window={weekWindow(today, 0)}
								today={today}
								showDone={showDone}
								selectedKey={selectedKey}
								editingKey={editingKey}
								{...handlers}
							/>
						</div>
					) : null}
				</div>
			)}

			<EventDeleteDialog
				target={deleting}
				busy={false}
				error={undefined}
				onConfirm={confirmDelete}
				onClose={() => setDeleting(undefined)}
			/>

			<KeybindsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
		</section>
	);
}
