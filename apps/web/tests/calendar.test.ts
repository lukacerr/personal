import type { CalendarCompletion, CalendarEvent } from '@web/lib/calendar';
// @vitest-environment happy-dom
import {
	addDays,
	backlogItems,
	collectEventTags,
	dayAgenda,
	editedEventDate,
	formatQuickAdd,
	formatTime,
	isoWeekday,
	isTagHidden,
	isToggleCalendarPanelShortcut,
	matchesEventSearch,
	occurrencesInRange,
	parseDetailLines,
	parseQuickAdd,
	parseTimeInput,
	scheduleItems,
	todayLocalDate,
	toggleDetailLine,
	weekBuckets,
	weekWindow,
} from '@web/lib/calendar';
import { describe, expect, it } from 'vitest';

let counter = 0;

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	counter += 1;
	return {
		id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
		title: `Event ${counter}`,
		details: null,
		tag: null,
		date: null,
		timeMinutes: null,
		recurrence: null,
		completedAt: null,
		createdAt: counter,
		updatedAt: counter,
		...overrides,
	};
}

describe('local date helpers', () => {
	it('steps across month and year ends without touching UTC', () => {
		expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('reports ISO weekdays: 08/18 was the Tuesday of the schedule note', () => {
		expect(isoWeekday('2026-08-17')).toBe(1);
		expect(isoWeekday('2026-08-18')).toBe(2);
		expect(isoWeekday('2026-08-15')).toBe(6);
		expect(isoWeekday('2026-08-16')).toBe(7);
	});

	it('formats today from the local clock, not UTC', () => {
		expect(todayLocalDate(new Date(2026, 7, 14, 23, 30))).toBe('2026-08-14');
		expect(todayLocalDate(new Date(2026, 7, 14, 0, 10))).toBe('2026-08-14');
	});
});

describe('time helpers', () => {
	it('formats minutes from midnight as HH:mm', () => {
		expect(formatTime(9 * 60 + 30)).toBe('09:30');
		expect(formatTime(18 * 60 + 45)).toBe('18:45');
		expect(formatTime(0)).toBe('00:00');
	});

	it('parses the native time input and rejects junk', () => {
		expect(parseTimeInput('09:30')).toBe(570);
		expect(parseTimeInput('18:45')).toBe(1125);
		expect(parseTimeInput('')).toBeNull();
		expect(parseTimeInput('25:00')).toBeNull();
	});
});

describe('parseQuickAdd', () => {
	const today = '2026-08-14';

	it('reads the full grammar: date, time, title, tag, repeat, until', () => {
		expect(
			parseQuickAdd('08/18 18:45 Innovación [uade] *火 <12/15', today),
		).toEqual({
			title: 'Innovación',
			done: false,
			date: '2026-08-18',
			dateExplicit: true,
			timeMinutes: 1125,
			tag: 'uade',
			recurrence: { kind: 'weekly', weekdays: [2], until: '2026-12-15' },
			details: null,
		});
	});

	it('defaults an absent date to today and an absent time to none', () => {
		expect(parseQuickAdd('Lavaseca', today)).toEqual({
			title: 'Lavaseca',
			done: false,
			date: today,
			dateExplicit: false,
			timeMinutes: null,
			tag: null,
			recurrence: null,
			details: null,
		});
		expect(parseQuickAdd('18:45 Tap', today)).toMatchObject({
			date: today,
			timeMinutes: 1125,
		});
	});

	it('sends !b to the backlog, dropping what cannot live there', () => {
		expect(parseQuickAdd('!b N4 JP [idioma]', today)).toEqual({
			title: 'N4 JP',
			done: false,
			date: null,
			dateExplicit: false,
			timeMinutes: null,
			tag: 'idioma',
			recurrence: null,
			details: null,
		});
		// Explicit contradictions resolve toward the backlog.
		expect(parseQuickAdd('08/16 12:00 !b Cosa *d', today)).toMatchObject({
			date: null,
			timeMinutes: null,
			recurrence: null,
		});
	});

	it('speaks every repeat form: *d, *Nd, kanji and ISO digits', () => {
		expect(parseQuickAdd('毎日 *d', today)).toMatchObject({
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		expect(parseQuickAdd('Pileta *3d', today)).toMatchObject({
			recurrence: { kind: 'everyDays', interval: 3 },
		});
		expect(parseQuickAdd('Clases *月木', today)).toMatchObject({
			recurrence: { kind: 'weekly', weekdays: [1, 4] },
		});
		expect(parseQuickAdd('Clases *15', today)).toMatchObject({
			recurrence: { kind: 'weekly', weekdays: [1, 5] },
		});
	});

	it('keeps lines after the first as details', () => {
		expect(
			parseQuickAdd('09/01 Pagar todo\nMono, CCs\nNuevo CBU', today),
		).toMatchObject({
			title: 'Pagar todo',
			date: '2026-09-01',
			details: 'Mono, CCs\nNuevo CBU',
		});
	});

	it('rolls a passed date forward and accepts a full one as-is', () => {
		expect(parseQuickAdd('01/05 Turno', today)).toMatchObject({
			date: '2027-01-05',
		});
		expect(parseQuickAdd('2026-08-20 Turno', today)).toMatchObject({
			date: '2026-08-20',
			dateExplicit: true,
		});
	});

	it('reads a date a few weeks back as the recent past, not next year', () => {
		// Yesterday-ish is the date just lived, not the same day next year:
		// this is what lets an inline edit round-trip a recent anchor as MM/dd.
		expect(parseQuickAdd('08/10 Cena', today)).toMatchObject({
			date: '2026-08-10',
		});
		// The window wraps the year: late December read in early January.
		expect(parseQuickAdd('12/28 Cena', '2027-01-10')).toMatchObject({
			date: '2026-12-28',
		});
		// Further back than the window, the old rule stands: forward.
		expect(parseQuickAdd('07/01 Cena', today)).toMatchObject({
			date: '2027-07-01',
		});
	});

	it('treats what cannot be a token as words', () => {
		expect(parseQuickAdd('02/30 Cosa', today)).toMatchObject({
			title: '02/30 Cosa',
			date: today,
		});
		expect(parseQuickAdd('25:00 Fiesta', today)).toMatchObject({
			title: '25:00 Fiesta',
		});
		// An until without a repeat is words, not a floating bound.
		expect(parseQuickAdd('Cosa <12/15', today)).toMatchObject({
			title: 'Cosa <12/15',
			recurrence: null,
		});
		expect(parseQuickAdd('   ', today)).toBeNull();
	});
});

describe('formatQuickAdd', () => {
	const today = '2026-08-14';

	it('round-trips an event through its own text form', () => {
		const event = makeEvent({
			title: 'Innovación',
			date: '2026-08-18',
			timeMinutes: 1125,
			tag: 'uade',
			recurrence: { kind: 'weekly', weekdays: [2], until: '2026-12-15' },
			details: 'EY Timesheets',
		});

		const text = formatQuickAdd(event, today);
		expect(text).toBe(
			'08/18 18:45 Innovación *火 <12/15 [uade]\nEY Timesheets',
		);
		expect(parseQuickAdd(text, today)).toMatchObject({
			title: 'Innovación',
			date: '2026-08-18',
			timeMinutes: 1125,
			tag: 'uade',
			recurrence: { kind: 'weekly', weekdays: [2], until: '2026-12-15' },
			details: 'EY Timesheets',
		});
	});

	it('writes a backlog item with !b at the very end, no clock', () => {
		const event = makeEvent({ title: 'N4 JP', tag: 'idioma' });
		expect(formatQuickAdd(event, today)).toBe('N4 JP [idioma] !b');
	});

	it('wears a leading [x] when done, and reads it back as done', () => {
		const done = makeEvent({
			title: 'Lavaseca',
			date: '2026-08-17',
			completedAt: 99,
		});
		expect(formatQuickAdd(done, today)).toBe('[x] 08/17 Lavaseca');
		expect(parseQuickAdd('[x] 08/17 Lavaseca', today)).toMatchObject({
			done: true,
			title: 'Lavaseca',
		});
		// Deleting the mark is how a row goes back to pending.
		expect(parseQuickAdd('08/17 Lavaseca', today)).toMatchObject({
			done: false,
		});
	});

	it('keeps MM/dd for the recent past and spells the year beyond it', () => {
		// Within the look-behind window MM/dd finds its way back on parse.
		const recent = makeEvent({ title: 'Cena', date: '2026-08-10' });
		expect(formatQuickAdd(recent, today)).toBe('08/10 Cena');
		expect(parseQuickAdd('08/10 Cena', today)).toMatchObject({
			date: '2026-08-10',
		});
		// Beyond it, MM/dd would roll forward a year, so the year is spelled.
		const old = makeEvent({ title: 'Viejo', date: '2026-01-10' });
		expect(formatQuickAdd(old, today)).toBe('2026-01-10 Viejo');
		expect(parseQuickAdd(formatQuickAdd(old, today), today)).toMatchObject({
			date: '2026-01-10',
		});
	});

	it('leaves an aged series anchor off the text instead of spelling it', () => {
		// A series edited months in never shows YYYY-MM-DD: the anchor MM/dd
		// cannot express is simply not written, and committing a dateless
		// series keeps the anchor (see editedEventDate).
		const series = makeEvent({
			title: 'Fast',
			date: '2026-01-10',
			timeMinutes: 525,
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		expect(formatQuickAdd(series, today)).toBe('08:45 Fast *d');
		// A reachable anchor still prints, as MM/dd.
		const fresh = makeEvent({
			title: 'Fast',
			date: '2026-08-10',
			timeMinutes: 525,
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		expect(formatQuickAdd(fresh, today)).toBe('08/10 08:45 Fast *d');
	});
});

describe('editedEventDate', () => {
	const today = '2026-08-14';

	it('keeps the anchor of a series whose edit text carries no date', () => {
		const series = makeEvent({
			date: '2026-01-10',
			timeMinutes: 525,
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		const parsed = parseQuickAdd(formatQuickAdd(series, today), today);
		expect(parsed && editedEventDate(series, parsed)).toBe('2026-01-10');
	});

	it('rebases the series when a date is written out, as asked', () => {
		const series = makeEvent({
			date: '2026-01-10',
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		const parsed = parseQuickAdd('08/20 Fast *d', today);
		expect(parsed && editedEventDate(series, parsed)).toBe('2026-08-20');
	});

	it('moves a dateless one-off to today, as before', () => {
		const oneOff = makeEvent({ date: '2026-08-18' });
		const parsed = parseQuickAdd('Lavaseca', today);
		expect(parsed && editedEventDate(oneOff, parsed)).toBe(today);
	});
});

describe('weekBuckets with custom groups', () => {
	it('keeps every day alone when no group covers it', () => {
		const buckets = weekBuckets('2026-08-21', '2026-08-23', []);
		expect(buckets.map((bucket) => bucket.dates)).toEqual([
			['2026-08-21'],
			['2026-08-22'],
			['2026-08-23'],
		]);
		expect(buckets[1]).toMatchObject({ title: '土', range: '08/22' });
	});

	it('merges the days a group covers, clipped to the window', () => {
		// The asked-for case: the coming weekend plus its holiday Monday.
		const group = { from: '2026-08-22', to: '2026-08-24', label: '週末' };
		const buckets = weekBuckets('2026-08-21', '2026-08-23', [group]);

		expect(buckets).toHaveLength(2);
		expect(buckets[1]).toMatchObject({
			title: '週末',
			range: '08/22–23',
			dates: ['2026-08-22', '2026-08-23'],
		});

		const whole = weekBuckets('2026-08-17', '2026-08-30', [group]);
		expect(whole.find((bucket) => bucket.dates.length > 1)?.range).toBe(
			'08/22–24',
		);
	});

	it('names an unlabelled group by its dates alone, across months too', () => {
		const buckets = weekBuckets('2026-08-28', '2026-09-02', [
			{ from: '2026-08-29', to: '2026-09-01' },
		]);
		const merged = buckets.find((bucket) => bucket.dates.length > 1);
		expect(merged).toMatchObject({ title: '', range: '08/29–09/01' });
	});

	it('ignores a group entirely outside the window', () => {
		const buckets = weekBuckets('2026-08-18', '2026-08-20', [
			{ from: '2026-09-01', to: '2026-09-03' },
		]);
		expect(buckets).toHaveLength(3);
	});
});

describe('tags', () => {
	it('collects each tag once, case-insensitively, sorted', () => {
		expect(
			collectEventTags([
				makeEvent({ tag: 'UADE' }),
				makeEvent({ tag: 'uade' }),
				makeEvent({ tag: 'salud' }),
				makeEvent(),
			]),
		).toEqual(['salud', 'UADE']);
	});

	it('hides an item only when its tag is hidden', () => {
		const hidden = ['uade'];
		expect(isTagHidden(makeEvent({ tag: 'UADE' }), hidden)).toBe(true);
		expect(isTagHidden(makeEvent({ tag: 'salud' }), hidden)).toBe(false);
		// Untagged never hides: there is no chip to bring it back with.
		expect(isTagHidden(makeEvent(), hidden)).toBe(false);
	});
});

describe('matchesEventSearch', () => {
	it('matches title, tag and details, case-insensitively', () => {
		const event = makeEvent({
			title: 'Innovación',
			tag: 'uade',
			details: 'EY Timesheets',
		});
		expect(matchesEventSearch(event, 'innova')).toBe(true);
		expect(matchesEventSearch(event, 'UADE')).toBe(true);
		expect(matchesEventSearch(event, 'timesheets')).toBe(true);
		expect(matchesEventSearch(event, 'pileta')).toBe(false);
		// A blank query matches nothing on purpose: it means "not searching".
		expect(matchesEventSearch(event, '  ')).toBe(false);
	});
});

describe('detail checklists', () => {
	it('reads every line as a check, with the [x] prefix carrying the state', () => {
		expect(parseDetailLines('Mono, CCs\n[x] Nuevo CBU\n[ ] Recetas')).toEqual([
			{ text: 'Mono, CCs', checked: false },
			{ text: 'Nuevo CBU', checked: true },
			{ text: 'Recetas', checked: false },
		]);
		expect(parseDetailLines(null)).toEqual([]);
	});

	it('toggles one line and leaves the neighbours untouched', () => {
		const toggled = toggleDetailLine('Mono, CCs\n[x] Nuevo CBU', 0);
		expect(toggled).toBe('[x] Mono, CCs\n[x] Nuevo CBU');
		expect(toggleDetailLine(toggled, 1)).toBe('[x] Mono, CCs\nNuevo CBU');
	});
});

describe('occurrencesInRange', () => {
	it('treats a one-off as its single date, inside the range only', () => {
		const event = makeEvent({ date: '2026-08-20' });
		expect(occurrencesInRange(event, '2026-08-18', '2026-08-23')).toEqual([
			'2026-08-20',
		]);
		expect(occurrencesInRange(event, '2026-08-21', '2026-08-31')).toEqual([]);
	});

	it('never places a backlog item on a day', () => {
		const event = makeEvent();
		expect(occurrencesInRange(event, '2026-01-01', '2026-12-31')).toEqual([]);
	});

	it('steps every X days from the anchor', () => {
		const event = makeEvent({
			date: '2026-08-18',
			recurrence: { kind: 'everyDays', interval: 3 },
		});
		expect(occurrencesInRange(event, '2026-08-18', '2026-08-27')).toEqual([
			'2026-08-18',
			'2026-08-21',
			'2026-08-24',
			'2026-08-27',
		]);
	});

	it('keeps the stride aligned to the anchor when the range starts later', () => {
		const event = makeEvent({
			date: '2026-08-10',
			recurrence: { kind: 'everyDays', interval: 2 },
		});
		expect(occurrencesInRange(event, '2026-08-17', '2026-08-22')).toEqual([
			'2026-08-18',
			'2026-08-20',
			'2026-08-22',
		]);
	});

	it('starts no series before its anchor', () => {
		const event = makeEvent({
			date: '2026-08-18',
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		expect(occurrencesInRange(event, '2026-08-10', '2026-08-17')).toEqual([]);
	});

	it('stops at until, inclusive', () => {
		const event = makeEvent({
			date: '2026-08-18',
			recurrence: { kind: 'everyDays', interval: 2, until: '2026-08-22' },
		});
		expect(occurrencesInRange(event, '2026-08-18', '2026-08-31')).toEqual([
			'2026-08-18',
			'2026-08-20',
			'2026-08-22',
		]);
	});

	it('lands weekly events on their weekdays, like the Tuesday/Thursday classes', () => {
		const event = makeEvent({
			date: '2026-08-18',
			recurrence: { kind: 'weekly', weekdays: [2, 4] },
		});
		expect(occurrencesInRange(event, '2026-08-18', '2026-08-28')).toEqual([
			'2026-08-18',
			'2026-08-20',
			'2026-08-25',
			'2026-08-27',
		]);
	});

	it('skips a weekly anchor whose own weekday is not in the set', () => {
		// Created on a Wednesday, repeating on Tuesdays: first hit is next Tuesday.
		const event = makeEvent({
			date: '2026-08-19',
			recurrence: { kind: 'weekly', weekdays: [2] },
		});
		expect(occurrencesInRange(event, '2026-08-17', '2026-08-31')).toEqual([
			'2026-08-25',
		]);
	});
});

describe('dayAgenda', () => {
	it('sorts timed items by time and leaves untimed ones after, in entry order', () => {
		const lavaseca = makeEvent({ date: '2026-08-18', createdAt: 1 });
		const rosita = makeEvent({ date: '2026-08-18', timeMinutes: 8 * 60 });
		const innovacion = makeEvent({
			date: '2026-08-18',
			timeMinutes: 18 * 60 + 45,
		});
		const pipeta = makeEvent({ date: '2026-08-18', createdAt: 2 });

		const items = dayAgenda(
			[lavaseca, innovacion, pipeta, rosita],
			[],
			'2026-08-18',
		);
		expect(items.map((item) => item.event.id)).toEqual([
			rosita.id,
			innovacion.id,
			lavaseca.id,
			pipeta.id,
		]);
	});

	it('marks a one-off done from its own row', () => {
		const event = makeEvent({ date: '2026-08-18', completedAt: 123 });
		const [item] = dayAgenda([event], [], '2026-08-18');
		expect(item?.status).toBe('done');
		expect(item?.recurring).toBe(false);
	});

	it('resolves a recurring occurrence from its completion for that day only', () => {
		const daily = makeEvent({
			date: '2026-08-01',
			timeMinutes: 9 * 60 + 30,
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		const completions: CalendarCompletion[] = [
			{ eventId: daily.id, date: '2026-08-18', status: 'done' },
		];

		expect(dayAgenda([daily], completions, '2026-08-18')[0]?.status).toBe(
			'done',
		);
		const pending = dayAgenda([daily], completions, '2026-08-20')[0];
		expect(pending?.status).toBe('pending');
		expect(pending?.recurring).toBe(true);
	});

	it('shows nothing for a day the series does not touch', () => {
		const weekly = makeEvent({
			date: '2026-08-18',
			recurrence: { kind: 'weekly', weekdays: [2] },
		});
		expect(dayAgenda([weekly], [], '2026-08-19')).toEqual([]);
	});
});

describe('scheduleItems', () => {
	it('lists every future one-off, however far, sorted by day and time', () => {
		const exam = makeEvent({
			date: '2026-12-16',
			title: 'Operativa 最後',
		});
		const launch = makeEvent({
			date: '2026-08-27',
			timeMinutes: 9 * 60,
			title: 'Tastewise launch',
		});
		const payday = makeEvent({ date: '2026-08-27', title: 'cc reset' });

		const items = scheduleItems([exam, payday, launch], [], {
			start: '2026-08-17',
			end: '2026-08-23',
		});
		expect(items.map((item) => item.event.id)).toEqual([
			launch.id,
			payday.id,
			exam.id,
		]);
	});

	it('leaves out what already happened or is on screen this week', () => {
		const past = makeEvent({ date: '2026-08-10' });
		const thisWeek = makeEvent({ date: '2026-08-23' });
		expect(
			scheduleItems([past, thisWeek], [], {
				start: '2026-08-17',
				end: '2026-08-23',
			}),
		).toEqual([]);
	});

	it('keeps quiet about a series already visible among the days', () => {
		const daily = makeEvent({
			date: '2026-08-01',
			recurrence: { kind: 'everyDays', interval: 1 },
		});
		expect(
			scheduleItems([daily], [], { start: '2026-08-17', end: '2026-08-23' }),
		).toEqual([]);
	});

	it('shows one next occurrence per recurring series, flagged as recurring', () => {
		const monthly = makeEvent({
			date: '2026-08-01',
			recurrence: { kind: 'everyDays', interval: 30 },
		});

		const items = scheduleItems([monthly], [], {
			start: '2026-08-17',
			end: '2026-08-23',
		});
		expect(items).toHaveLength(1);
		expect(items[0]?.date).toBe('2026-08-31');
		expect(items[0]?.recurring).toBe(true);
	});

	it('drops a series whose until has passed', () => {
		const ended = makeEvent({
			date: '2026-08-01',
			recurrence: { kind: 'everyDays', interval: 7, until: '2026-08-20' },
		});
		expect(
			scheduleItems([ended], [], { start: '2026-08-17', end: '2026-08-23' }),
		).toEqual([]);
	});

	it('never lists backlog items', () => {
		expect(
			scheduleItems([makeEvent()], [], {
				start: '2026-08-17',
				end: '2026-08-23',
			}),
		).toEqual([]);
	});
});

describe('backlogItems', () => {
	it('keeps pending items in entry order and sinks the done ones', () => {
		const licencia = makeEvent({ createdAt: 10 });
		const tattoo = makeEvent({ createdAt: 20 });
		const done = makeEvent({ createdAt: 5, completedAt: 99 });
		const dated = makeEvent({ date: '2026-08-20' });

		expect(
			backlogItems([tattoo, done, dated, licencia]).map((event) => event.id),
		).toEqual([licencia.id, tattoo.id, done.id]);
	});
});

describe('weekWindow', () => {
	it('shows at least fourteen days from today and closes on a Sunday', () => {
		// Friday the 14th reaches through the *next* full weekend: Sunday the 30th.
		expect(weekWindow('2026-08-14', 0)).toEqual({
			start: '2026-08-14',
			end: '2026-08-30',
		});
		expect(weekWindow('2026-08-16', 0)).toEqual({
			start: '2026-08-16',
			end: '2026-08-30',
		});
		// Fourteen days that land on a Monday stretch to that week's Sunday.
		expect(weekWindow('2026-08-18', 0)).toEqual({
			start: '2026-08-18',
			end: '2026-09-06',
		});
	});

	it('walks whole Monday-to-Sunday weeks into the past and future', () => {
		expect(weekWindow('2026-08-18', -1)).toEqual({
			start: '2026-08-10',
			end: '2026-08-16',
		});
		expect(weekWindow('2026-08-18', 1)).toEqual({
			start: '2026-08-24',
			end: '2026-08-30',
		});
	});
});

describe('isToggleCalendarPanelShortcut', () => {
	const base = {
		altKey: true,
		ctrlKey: true,
		metaKey: false,
		shiftKey: false,
		repeat: false,
		key: 'b',
		target: null,
	};

	it('claims Ctrl/Cmd+Alt+B and nothing the shell already owns', () => {
		expect(isToggleCalendarPanelShortcut(base)).toBe(true);
		expect(
			isToggleCalendarPanelShortcut({ ...base, ctrlKey: false, metaKey: true }),
		).toBe(true);
		// Ctrl+B alone is the app sidebar; a bare letter is typing.
		expect(isToggleCalendarPanelShortcut({ ...base, altKey: false })).toBe(
			false,
		);
		expect(isToggleCalendarPanelShortcut({ ...base, ctrlKey: false })).toBe(
			false,
		);
	});
});
