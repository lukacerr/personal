import type {
	CalendarCompletion,
	CalendarEvent,
	CompletionStatus,
	EventRecurrence,
} from '@web/lib/calendar-api';
import {
	isBareLetterShortcut,
	isEditableTarget,
	type ShortcutEvent,
} from '@web/lib/keyboard';

export type {
	CalendarCompletion,
	CalendarEvent,
	CompletionStatus,
	EventRecurrence,
} from '@web/lib/calendar-api';

/**
 * Everything Calendar knows how to compute, with no React, no network and no
 * storage in sight. Local dates, series expansion, the day buckets and the
 * schedule all live here so they can be reasoned about — and tested — alone.
 *
 * A date is always a local `YYYY-MM-DD` string. "The 18th" means the 18th
 * wherever the calendar is read; a UTC instant would shift it across midnight
 * depending on the device. Arithmetic runs through `Date.UTC` purely as a
 * calendar, never as a clock, so it cannot be bent by the runtime's zone.
 */

/** The bare letter lands the caret on the add line; Ctrl/Cmd+A stays select all. */
export function isAddEventShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'a');
}

/** `e` opens the selected row as text, in place. */
export function isEditSelectionShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'e');
}

/** `c` clones the selection and opens the copy for editing. */
export function isCloneShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'c');
}

/** `d` flips the done filter — the fix for a mis-check hiding itself. */
export function isToggleDoneFilterShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'd');
}

/** `f` opens the tag filter. */
export function isTagFilterShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'f');
}

/**
 * Ctrl/Cmd+F is claimed whole — including inside text fields: the Tauri shell
 * has no native find to fall back on, and this screen's own search is the
 * useful answer everywhere on it.
 */
export function isFindShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		event.key.toLowerCase() === 'f'
	);
}

/** `?` opens the keys-and-grammar sheet (bare letters admit Shift). */
export function isHelpShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, '?');
}

/**
 * Ctrl/Cmd+Z, outside any text field: inside one, the field's own undo is the
 * right owner of the chord.
 */
export function isUndoShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		!isEditableTarget(event.target) &&
		event.key.toLowerCase() === 'z'
	);
}

/**
 * Ctrl/Cmd+Alt+B folds the backlog/schedule column away. The Alt is what
 * separates it from the shell's own Ctrl/Cmd+B, whose predicate requires
 * Alt to be up — the two can never fire together.
 */
export function isToggleCalendarPanelShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		!isEditableTarget(event.target) &&
		event.key.toLowerCase() === 'b'
	);
}

/* -------------------------------------------------------------------------- */
/* Local dates                                                                 */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

function toUtc(date: string) {
	const [year, month, day] = date.split('-').map(Number);
	return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function fromUtc(at: number) {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(date: string, days: number) {
	return fromUtc(toUtc(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string) {
	return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string) {
	const day = new Date(toUtc(date)).getUTCDay();
	return day === 0 ? 7 : day;
}

/** The day headers speak the note's own language: 月火水木金土日. */
export const WEEKDAY_KANJI = [
	'月',
	'火',
	'水',
	'木',
	'金',
	'土',
	'日',
] as const;

export function weekdayKanji(date: string) {
	return WEEKDAY_KANJI[isoWeekday(date) - 1] ?? '';
}

export function todayLocalDate(now = new Date()) {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function datesInRange(start: string, end: string) {
	const dates: string[] = [];
	for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
	return dates;
}

/** The note's own date notation: `08/18`. */
export const formatShortDate = (date: string) =>
	date.slice(5).replace('-', '/');

/** Consecutive days read as one bucket — a long weekend, a trip. */
export type CalendarDayGroup = { from: string; to: string; label?: string };

export type WeekBucket = {
	key: string;
	/** The kanji for a single day, the group's label (possibly empty) otherwise. */
	title: string;
	/** The mono half of the heading: `08/22` or `08/22–24`. */
	range: string;
	dates: string[];
};

/** `08/22–24`, spelling the month again only when it changes. */
function rangeLabel(first: string, last: string) {
	if (first === last) return formatShortDate(first);
	const sameMonth = first.slice(0, 7) === last.slice(0, 7);
	return `${formatShortDate(first)}–${sameMonth ? last.slice(8) : formatShortDate(last)}`;
}

/**
 * The buckets the window renders: one per day, except where a custom group
 * covers several — the weekend plus its holiday Monday. The note's fixed 週末
 * grouping existed for the comfort of writing plain text; here grouping is
 * whatever was declared, clipped to the window, and nothing is locked in.
 */
export function weekBuckets(
	start: string,
	end: string,
	groups: CalendarDayGroup[],
): WeekBucket[] {
	const buckets: WeekBucket[] = [];
	for (const date of datesInRange(start, end)) {
		const group = groups.find(
			(entry) => entry.from <= date && date <= entry.to,
		);
		const last = buckets[buckets.length - 1];
		if (group && last?.key === `group:${group.from}`) {
			last.dates.push(date);
			last.range = rangeLabel(last.dates[0] ?? date, date);
			continue;
		}
		buckets.push(
			group
				? {
						key: `group:${group.from}`,
						title: group.label ?? '',
						range: rangeLabel(date, date),
						dates: [date],
					}
				: {
						key: date,
						title: weekdayKanji(date),
						range: formatShortDate(date),
						dates: [date],
					},
		);
	}
	return buckets;
}

/* -------------------------------------------------------------------------- */
/* Times                                                                       */
/* -------------------------------------------------------------------------- */

export function formatTime(timeMinutes: number) {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(Math.floor(timeMinutes / 60))}:${pad(timeMinutes % 60)}`;
}

/** What the native time input yields, or `null` when it holds nothing usable. */
export function parseTimeInput(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** `MM/dd` in this year, or the next one if that day already went by. */
function resolveShortDate(token: string, today: string): string | null {
	const full = /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : null;
	const match = /^(\d{1,2})\/(\d{1,2})$/.exec(token);
	if (!full && !match) return null;
	const pad = (value: string) => value.padStart(2, '0');
	const sameYear =
		full ??
		`${today.slice(0, 4)}-${pad(match?.[1] ?? '')}-${pad(match?.[2] ?? '')}`;
	const candidate =
		!full && sameYear < today
			? `${Number(today.slice(0, 4)) + 1}${sameYear.slice(4)}`
			: sameYear;
	// The parts must survive the round trip: 02/30 is words, not a date.
	const [year, month, day] = candidate.split('-').map(Number);
	const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day));
	return parsed.getUTCMonth() === (month ?? 1) - 1 &&
		parsed.getUTCDate() === day
		? candidate
		: null;
}

const KANJI_TO_WEEKDAY = new Map<string, number>(
	WEEKDAY_KANJI.map((kanji, index) => [kanji, index + 1]),
);

/** `*d`, `*3d`, `*月木`, `*15` — or null when the token is just words. */
function parseRepeatToken(
	token: string,
):
	| { kind: 'everyDays'; interval: number }
	| { kind: 'weekly'; weekdays: number[] }
	| null {
	if (token === '*d') return { kind: 'everyDays', interval: 1 };
	const every = /^\*(\d{1,3})d$/.exec(token);
	if (every) {
		const interval = Number(every[1]);
		return interval >= 1 && interval <= 365
			? { kind: 'everyDays', interval }
			: null;
	}
	const body = /^\*(\S+)$/.exec(token)?.[1];
	if (!body) return null;
	const weekdays = [...body].map(
		(char) =>
			KANJI_TO_WEEKDAY.get(char) ??
			(/^[1-7]$/.test(char) ? Number(char) : Number.NaN),
	);
	if (weekdays.some(Number.isNaN)) return null;
	const unique = [...new Set(weekdays)].sort((a, b) => a - b);
	return unique.length > 0 ? { kind: 'weekly', weekdays: unique } : null;
}

export type QuickAddParse = {
	title: string;
	/** A leading `[x]`; its absence is what "not done" looks like. */
	done: boolean;
	/** `null` is the backlog, asked for with `!b`. */
	date: string | null;
	timeMinutes: number | null;
	tag: string | null;
	recurrence: EventRecurrence | null;
	details: string | null;
};

/**
 * The one grammar for writing an event, whole:
 *
 *     [MM/dd] [HH:mm] título … [tag] !b *repeat <MM/dd
 *     líneas siguientes → details
 *
 * Everything but the title is optional; no date means today; `!b` means the
 * backlog and silently drops what cannot live there (a clock, a series). A
 * token that cannot be what it looks like — `02/30`, `25:00`, an `<until`
 * with no repeat — is words and stays in the title. This is both what the
 * quick-add reads and what the inline editor writes back via
 * `formatQuickAdd`, so the two must stay exact inverses.
 */
export function parseQuickAdd(
	input: string,
	today: string,
): QuickAddParse | null {
	const [firstLine = '', ...restLines] = input.split('\n');
	const details = restLines.join('\n').trim() || null;
	let head = firstLine.trim();
	if (!head && !details) return null;

	// The done mark before the tag: `[x]` is bracketed too, and only a
	// LEADING one means done — anywhere else it is words.
	const done = /^\[x\]\s+/i.test(head);
	if (done) head = head.replace(/^\[x\]\s+/i, '');

	// The tag next: brackets may hold spaces, so it cannot be tokenised.
	const tagMatch = /\[([^\]]{1,64})\]/.exec(head);
	const tag = tagMatch?.[1]?.trim() || null;
	if (tagMatch) head = head.replace(tagMatch[0], ' ');

	let backlog = false;
	let recurrence: EventRecurrence | null = null;
	let until: string | null = null;

	const words = head.split(/\s+/).filter((word) => word !== '');
	const rest: string[] = [];
	for (const word of words) {
		if (word === '!b') {
			backlog = true;
			continue;
		}
		if (word.startsWith('*')) {
			const repeat = parseRepeatToken(word);
			if (repeat) {
				recurrence = repeat;
				continue;
			}
		}
		if (word.startsWith('<')) {
			const bound = resolveShortDate(word.slice(1), today);
			if (bound) {
				until = bound;
				continue;
			}
		}
		rest.push(word);
	}

	let date: string | null = today;
	let timeMinutes: number | null = null;
	if (rest.length > 1) {
		const explicit = resolveShortDate(rest[0] ?? '', today);
		if (explicit !== null) {
			date = explicit;
			rest.shift();
		}
	}
	if (rest.length > 1 && /^\d{1,2}:\d{2}$/.test(rest[0] ?? '')) {
		const time = parseTimeInput(rest[0] ?? '');
		if (time !== null) {
			timeMinutes = time;
			rest.shift();
		}
	}

	// An until with no repeat is words; a repeat keeps its bound inside itself.
	if (recurrence && until) recurrence = { ...recurrence, until };
	if (!recurrence && until) rest.push(`<${formatShortDate(until)}`);

	const title = rest.join(' ').trim();
	if (!title) return null;

	if (backlog)
		return {
			title,
			done: false,
			date: null,
			timeMinutes: null,
			tag,
			recurrence: null,
			details,
		};
	return { title, done, date, timeMinutes, tag, recurrence, details };
}

/** How far ahead `MM/dd` can point before the year has to be spelled out. */
function shortDateToken(date: string, today: string) {
	return date >= today &&
		resolveShortDate(formatShortDate(date), today) === date
		? formatShortDate(date)
		: date;
}

function formatRepeat(recurrence: EventRecurrence, today: string) {
	const head =
		recurrence.kind === 'everyDays'
			? recurrence.interval === 1
				? '*d'
				: `*${recurrence.interval}d`
			: `*${recurrence.weekdays.map((day) => WEEKDAY_KANJI[day - 1] ?? '').join('')}`;
	return recurrence.until
		? `${head} <${shortDateToken(recurrence.until, today)}`
		: head;
}

/**
 * The exact inverse of `parseQuickAdd`, which is what makes inline editing
 * honest: the row turns into this text, and saving parses it back. The date
 * is always written — editing must not re-default to today — and it falls
 * back to the full `YYYY-MM-DD` whenever `MM/dd` would not resolve to the
 * same day again (the past rolls forward on parse).
 */
export function formatQuickAdd(event: CalendarEvent, today: string) {
	const parts: string[] = [];
	// Reading order: done mark, when, what, how it repeats, tag, and the
	// backlog flag last — absence of the leading `[x]` is "not done".
	if (event.date !== null && event.completedAt !== null) parts.push('[x]');
	if (event.date !== null) {
		parts.push(shortDateToken(event.date, today));
		if (event.timeMinutes !== null) parts.push(formatTime(event.timeMinutes));
	}
	parts.push(event.title);
	if (event.date !== null && event.recurrence)
		parts.push(formatRepeat(event.recurrence, today));
	if (event.tag) parts.push(`[${event.tag}]`);
	if (event.date === null) parts.push('!b');

	const head = parts.join(' ');
	return event.details ? `${head}\n${event.details}` : head;
}

/* -------------------------------------------------------------------------- */
/* Detail checklists                                                           */
/* -------------------------------------------------------------------------- */

export type DetailLine = { text: string; checked: boolean };

const CHECKED_PREFIX = /^\[x\]\s+/i;
const UNCHECKED_PREFIX = /^\[\s?\]\s+/;

/**
 * Details are the note's sub-bullets, so every line renders as a sub-check.
 * The state lives in the text itself (`[x] …`), which keeps the column a
 * plain string: no migration, no second table, and the same patch that edits
 * details already syncs a toggle.
 */
export function parseDetailLines(details: string | null): DetailLine[] {
	if (!details) return [];
	return details
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.map((line) => ({
			text: line.replace(CHECKED_PREFIX, '').replace(UNCHECKED_PREFIX, ''),
			checked: CHECKED_PREFIX.test(line),
		}));
}

export function toggleDetailLine(details: string, index: number): string {
	return parseDetailLines(details)
		.map((line, at) => {
			const checked = at === index ? !line.checked : line.checked;
			return checked ? `[x] ${line.text}` : line.text;
		})
		.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Series expansion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The local dates in `[from, to]` this event falls on. A one-off is its single
 * date; a series is expanded from its anchor — the event's own `date` — and
 * clipped by `until`. Occurrences are never materialised anywhere: whatever is
 * on screen calls this over its own window.
 */
export function occurrencesInRange(
	event: CalendarEvent,
	from: string,
	to: string,
): string[] {
	if (!event.date) return [];
	if (!event.recurrence)
		return event.date >= from && event.date <= to ? [event.date] : [];

	const until = event.recurrence.until;
	const end = until !== undefined && until < to ? until : to;
	const start = event.date > from ? event.date : from;
	if (start > end) return [];

	const dates: string[] = [];
	if (event.recurrence.kind === 'everyDays') {
		const { interval } = event.recurrence;
		// First stride landing on or after `start`, aligned to the anchor.
		const offset = daysBetween(event.date, start);
		const misaligned = offset % interval;
		let cursor =
			misaligned === 0 ? start : addDays(start, interval - misaligned);
		while (cursor <= end) {
			dates.push(cursor);
			cursor = addDays(cursor, interval);
		}
		return dates;
	}

	const weekdays = new Set(event.recurrence.weekdays);
	for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1))
		if (weekdays.has(isoWeekday(cursor))) dates.push(cursor);
	return dates;
}

/* -------------------------------------------------------------------------- */
/* Agenda                                                                      */
/* -------------------------------------------------------------------------- */

export type AgendaItem = {
	event: CalendarEvent;
	/** The occurrence's day — for a series, not the anchor. */
	date: string;
	status: 'pending' | CompletionStatus;
	recurring: boolean;
};

export function completionKey(eventId: string, date: string) {
	return `${eventId}:${date}`;
}

function completionsByKey(completions: CalendarCompletion[]) {
	return new Map(
		completions.map((row) => [
			completionKey(row.eventId, row.date),
			row.status,
		]),
	);
}

function toItem(
	event: CalendarEvent,
	date: string,
	resolved: Map<string, CompletionStatus>,
): AgendaItem {
	const recurring = event.recurrence !== null;
	const status = recurring
		? (resolved.get(completionKey(event.id, date)) ?? 'pending')
		: event.completedAt !== null
			? 'done'
			: 'pending';
	return { event, date, status, recurring };
}

/**
 * Timed items first, in day order; the untimed thoughts of the day after them,
 * in the order they were written. That is exactly how the schedule note read.
 */
function byTimeThenEntry(a: AgendaItem, b: AgendaItem) {
	const aTime = a.event.timeMinutes;
	const bTime = b.event.timeMinutes;
	if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
	if ((aTime !== null) !== (bTime !== null)) return aTime !== null ? -1 : 1;
	return a.event.createdAt - b.event.createdAt;
}

export function dayAgenda(
	events: CalendarEvent[],
	completions: CalendarCompletion[],
	date: string,
): AgendaItem[] {
	const resolved = completionsByKey(completions);
	return events
		.filter((event) => occurrencesInRange(event, date, date).length > 0)
		.map((event) => toItem(event, date, resolved))
		.sort(byTimeThenEntry);
}

/**
 * What comes after the window on screen — the old note's "Schedule" section.
 *
 * Every future one-off is listed however far away it is: a December exam is
 * exactly what this section exists to hold. A series would flood it, so it
 * contributes a single next occurrence, flagged, which both says "this
 * continues" and keeps a sparse series (every 30 days) findable when no
 * visible day shows it.
 */
export function scheduleItems(
	events: CalendarEvent[],
	completions: CalendarCompletion[],
	window: { start: string; end: string },
): AgendaItem[] {
	const afterDate = window.end;
	const resolved = completionsByKey(completions);
	const items: AgendaItem[] = [];

	for (const event of events) {
		if (!event.date) continue;
		if (!event.recurrence) {
			if (event.date > afterDate)
				items.push(toItem(event, event.date, resolved));
			continue;
		}
		// A series already on screen among the days needs no reminder here:
		// the schedule slot exists to keep the *sparse* series findable.
		if (occurrencesInRange(event, window.start, window.end).length > 0)
			continue;
		const searchFrom =
			event.date > afterDate ? event.date : addDays(afterDate, 1);
		// An everyDays stride lands within one interval of any day; a weekly one
		// within seven. 366 covers both bounds with room and stays finite.
		const [next] = occurrencesInRange(
			event,
			searchFrom,
			addDays(searchFrom, 366),
		);
		if (next) items.push(toItem(event, next, resolved));
	}

	return items.sort(
		(a, b) => a.date.localeCompare(b.date) || byTimeThenEntry(a, b),
	);
}

/** Every tag present, once, case-insensitively merged and sorted. */
export function collectEventTags(events: CalendarEvent[]) {
	const seen = new Map<string, string>();
	for (const event of events) {
		if (!event.tag) continue;
		const key = event.tag.toLocaleLowerCase();
		if (!seen.has(key)) seen.set(key, event.tag);
	}
	return [...seen.values()].sort((a, b) =>
		a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()),
	);
}

/**
 * The find box's own question: does this event speak of the query at all —
 * title, tag or details. Case-insensitive substring, which is what a person
 * means when they type. A blank query matches nothing: it means the search
 * is not on, not "everything".
 */
export function matchesEventSearch(event: CalendarEvent, query: string) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return false;
	return [event.title, event.tag, event.details].some((field) =>
		field?.toLocaleLowerCase().includes(needle),
	);
}

/**
 * Whether the tag filter hides this event. Untagged never hides: there would
 * be no chip to bring it back with.
 */
export function isTagHidden(event: CalendarEvent, hiddenTags: string[]) {
	if (!event.tag) return false;
	const key = event.tag.toLocaleLowerCase();
	return hiddenTags.some((tag) => tag.toLocaleLowerCase() === key);
}

/**
 * The dateless items — what the quote block at the top of the note held.
 * Pending ones read in the order they were written; the done ones sink.
 */
export function backlogItems(events: CalendarEvent[]): CalendarEvent[] {
	return events
		.filter((event) => event.date === null)
		.sort((a, b) => {
			const aDone = a.completedAt !== null;
			const bDone = b.completedAt !== null;
			if (aDone !== bDone) return aDone ? 1 : -1;
			return a.createdAt - b.createdAt;
		});
}

/* -------------------------------------------------------------------------- */
/* The visible week                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The window the day buckets cover. The current view opens at today — the
 * days already behind are history, not agenda — spans at least fourteen days,
 * and stretches to close on a Sunday, so the next full weekend is always in
 * sight. Any other offset is a whole Monday-to-Sunday week, which is how the
 * past is browsed.
 */
export function weekWindow(today: string, offsetWeeks: number) {
	if (offsetWeeks === 0) {
		const horizon = addDays(today, 13);
		return { start: today, end: addDays(horizon, 7 - isoWeekday(horizon)) };
	}
	const monday = addDays(today, 1 - isoWeekday(today));
	const start = addDays(monday, offsetWeeks * 7);
	return { start, end: addDays(start, 6) };
}
