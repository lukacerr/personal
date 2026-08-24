import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import { clearLocalCalendar } from '@web/lib/calendar-db';
import { describeDiscardedSync, refreshCalendar } from '@web/lib/calendar-sync';
import { CalendarDaysIcon } from 'lucide-react';
import { toast } from 'sonner';

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
