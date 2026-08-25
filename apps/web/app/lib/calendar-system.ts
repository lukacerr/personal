import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import {
	formatUpcomingWhen,
	isTagHidden,
	todayLocalDate,
	upcomingAgenda,
} from '@web/lib/calendar';
import { calendarDb, clearLocalCalendar } from '@web/lib/calendar-db';
import { describeDiscardedSync, refreshCalendar } from '@web/lib/calendar-sync';
import { CalendarDaysIcon } from 'lucide-react';
import { toast } from 'sonner';

/** Three lines is what fits beside the navigation without crowding it out. */
const UPCOMING_LIMIT = 3;

/**
 * Tags whose events never earn one of those three lines.
 *
 * They mark the routine that fills most days — the taps and the repeats — and
 * with them in, a habit that recurs daily would take every slot every day and
 * the summary would never say anything a glance did not already know. They stay
 * on the screen itself, which is where the routine is the point.
 *
 * Only here: the screen's own tag filter is a view control someone toggles,
 * while this is a standing rule about what the sidebar is for.
 */
const SUMMARY_HIDDEN_TAGS = ['タップ', '回'];

/**
 * Calendar in the shell. Only the action, deliberately — like Finance's: an
 * event is not a place you go *to*, it is read as part of its day, and the
 * screen already lays the week out. The palette navigates and does not run
 * callbacks, so the action is a link to a url the screen consumes and clears.
 *
 * Calendar's data lives in Dexie, so the shell's own `useLiveQuery` tracks it
 * without a `subscribe` — nothing here reads it yet, but adding event search
 * later would come for free.
 */
export const calendarSystem: AppSystem = {
	key: 'calendar',
	heading: 'Calendar',
	icon: CalendarDaysIcon,

	/** Events and their queued operations are private; sign-out erases them. */
	clearLocalData: clearLocalCalendar,

	/**
	 * Drains the outbox before pulling, as every other entry point does. A
	 * discarded operation is a local edit that will never reach the server, so it
	 * speaks even though the refresh behind it was nobody's explicit request.
	 */
	async refresh(_search, isCurrent) {
		const result = await refreshCalendar(isCurrent);
		if (result.status !== 'refreshed') return false;
		for (const failure of result.discarded)
			toast.error(describeDiscardedSync(failure));
		return true;
	},

	/**
	 * Not for reading — nothing outside this screen shows events — but for the
	 * outbox: an edit queued offline has to ship on the next connection even if
	 * the reader has walked to another screen since. Without this, reconnecting
	 * anywhere else left it waiting for the next visit to `/calendar`.
	 */
	refreshEverywhere: true,

	/**
	 * What is next, which is the one thing about a calendar worth knowing from
	 * a screen that is not the calendar.
	 *
	 * The rows are readings and not links, for the same reason
	 * `loadBreadcrumbTrail` is empty: the url carries no selection, so there is
	 * nowhere to point at an occurrence. The group's own label reaches the
	 * screen, and inventing a `?date=` nothing consumes would be a dead link.
	 *
	 * Today counts whole — see `upcomingAgenda` — so the first row can be
	 * something whose hour has already passed.
	 */
	async loadSummary() {
		const [events, completions] = await Promise.all([
			calendarDb.events.toArray(),
			calendarDb.completions.toArray(),
		]);
		const worth = events.filter(
			(event) => !isTagHidden(event, SUMMARY_HIDDEN_TAGS),
		);
		return {
			rows: upcomingAgenda(
				worth,
				completions,
				todayLocalDate(),
				UPCOMING_LIMIT,
			).map((item) => ({
				// A series shows up on several days, so the day is part of the key.
				key: `${item.event.id}:${item.date}`,
				label: item.event.title,
				detail: formatUpcomingWhen(item.date, item.event.timeMinutes),
			})),
		};
	},

	async searchCommands(query, limit) {
		if (limit < 1) return [];
		if (!matchesCommandQuery(query, 'Add event', 'new evento schedule'))
			return [];
		return [
			{
				id: 'create',
				label: 'Add event',
				detail: 'Calendar',
				to: '/calendar?new=1',
			},
		];
	},

	async loadBreadcrumbTrail() {
		// The screen has no sub-records to point at: dialogs are ephemeral and
		// the url carries no selection.
		return [];
	},
};
