import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import { clearLocalCalendar } from '@web/lib/calendar-db';
import { CalendarDaysIcon } from 'lucide-react';

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
