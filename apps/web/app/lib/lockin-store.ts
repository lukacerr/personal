import {
	createIndexCore,
	type IndexCore,
	type IndexLoadOutcome,
	offlineMessage,
} from '@web/lib/index-store';
import { formatDay, shiftDate } from '@web/lib/lockin';
import {
	type LockinAnswers,
	LockinApiError,
	type LockinDay,
	type LockinWindow,
	listLockinDays,
	saveLockinDay,
} from '@web/lib/lockin-api';
import type { SessionWorkGuard } from '@web/lib/session-work';
import { create } from 'zustand';

/** The index core keys its rows by `id`; a day's identity is its date. */
type IndexedDay = LockinDay & { id: string };

type LockinState = IndexCore & {
	/** What the server says the challenge spans; absent until the first load. */
	window?: LockinWindow;
	days: IndexedDay[];
	load: (
		force?: boolean,
		isCurrent?: SessionWorkGuard,
	) => Promise<IndexLoadOutcome>;
	reset: () => void;
	upsert: (days: IndexedDay[]) => void;
	remove: (ids: string[]) => void;
	save: (date: string, answers: LockinAnswers) => Promise<string | undefined>;
};

const indexed = (day: LockinDay): IndexedDay => ({ ...day, id: day.date });

/** Each refusal in its own words: they have different fixes. */
function refusalMessage(date: string, error: unknown) {
	if (!(error instanceof LockinApiError)) return offlineMessage('This day');
	switch (error.refusal) {
		case 'LOCKIN_PREVIOUS_DAY_INCOMPLETE':
			return `Finish ${formatDay(shiftDate(date, -1))} first: days are logged in order.`;
		case 'LOCKIN_LATER_DAY_LOGGED':
			return `${formatDay(shiftDate(date, 1))} is already logged, so every answer here has to stay filled.`;
		case 'LOCKIN_SUNDAY_IS_REST':
			return 'Sunday is the rest day: no session to log.';
		case 'LOCKIN_OUTSIDE_WINDOW':
			return 'This day is outside the challenge.';
		default:
			return error.status >= 500
				? offlineMessage('This day')
				: 'The server would not take these answers. Check them and try again.';
	}
}

/**
 * The one copy of the challenge log the app keeps.
 *
 * Not local-first, like Finance: the API is the source and the whole log — at
 * most 35 rows — comes down in one conditional read. The window rides along
 * with it, so the dates the client judges are the dates the server enforces.
 */
export const useLockinStore = create<LockinState>()((set, get) => {
	// Applied only through `patch`, which the core calls after its session
	// guard: a read that lands after sign-out cannot bring the window back.
	let answeredWindow: LockinWindow | undefined;

	const index = createIndexCore<LockinState, IndexedDay>({
		get,
		patch: ({ items, ...core }) =>
			set(items ? { ...core, days: items, window: answeredWindow } : core),
		read: async (knownTag) => {
			const answer = await listLockinDays(knownTag);
			if (answer === 'unchanged') return answer;
			answeredWindow = answer.window;
			return { items: answer.days.map(indexed), tag: answer.tag };
		},
		select: (state) => state.days,
		failure: {
			unreachable:
				'Your lock-in log could not reach the server. Try again in a moment.',
			offline: 'No connection. Lock-in needs to reach the server.',
		},
	});

	return {
		days: [],
		...index,

		reset() {
			answeredWindow = undefined;
			index.reset();
			set({ window: undefined });
		},

		async save(date, answers) {
			try {
				const saved = await saveLockinDay(date, answers);
				get().upsert([indexed(saved)]);
			} catch (error) {
				return refusalMessage(date, error);
			}
		},
	};
});

/** Reads the log without subscribing, for the system registry's loaders. */
export const lockinSnapshot = () => useLockinStore.getState();

/** The log as the rules read it: one entry per logged date. */
export const lockinLogOf = (days: LockinDay[]) =>
	new Map(days.map((day) => [day.date, day]));
