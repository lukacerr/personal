import type { CalendarDayGroup } from '@web/lib/calendar';
import { z } from 'zod';

/**
 * How Luka reads the calendar rather than what is on it: the custom day
 * groups and which tags are hidden. Shared across devices through
 * `GET`/`PUT /events/settings` — the same Redis key-value pattern Finance
 * uses — with this localStorage mirror keeping the screen alive with no
 * network and reseeding the cache after an eviction.
 */

export const CALENDAR_SETTINGS_KEY = 'personal-calendar-settings:v1';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const settingsSchema = z.object({
	version: z.literal(1),
	groups: z
		.array(
			z
				.object({
					from: localDate,
					to: localDate,
					label: z.string().trim().min(1).max(40).optional(),
				})
				.refine(({ from, to }) => from <= to),
		)
		.optional(),
	hiddenTags: z.array(z.string().min(1).max(64)).optional(),
	hideUntagged: z.boolean().optional(),
});

export type CalendarSettings = {
	groups?: CalendarDayGroup[];
	hiddenTags?: string[];
	hideUntagged?: boolean;
};

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {};

export function loadCalendarSettings(
	storage: Pick<SettingsStorage, 'getItem'>,
): CalendarSettings {
	try {
		const raw = storage.getItem(CALENDAR_SETTINGS_KEY);
		if (!raw) return DEFAULT_CALENDAR_SETTINGS;
		const parsed = settingsSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return DEFAULT_CALENDAR_SETTINGS;

		// Built key by key rather than spread, so an absent field stays absent
		// instead of becoming a present `undefined`.
		const settings: CalendarSettings = {};
		if (parsed.data.groups) settings.groups = parsed.data.groups;
		if (parsed.data.hiddenTags) settings.hiddenTags = parsed.data.hiddenTags;
		if (parsed.data.hideUntagged !== undefined)
			settings.hideUntagged = parsed.data.hideUntagged;
		return settings;
	} catch {
		return DEFAULT_CALENDAR_SETTINGS;
	}
}

/** Whether there is anything here worth seeding the shared copy with. */
function isRemembered(settings: CalendarSettings) {
	return (
		settings.groups !== undefined ||
		settings.hiddenTags !== undefined ||
		settings.hideUntagged !== undefined
	);
}

export type CalendarSettingsReconciliation = {
	settings: CalendarSettings;
	/** Whether the local copy has to be pushed up, because the cache had none. */
	push: boolean;
};

/**
 * Which copy the screen opens on — the same precedence Finance settled on.
 *
 * The shared copy decides whenever there is one, so a phone that never
 * grouped a weekend adopts the groups instead of starting over. The local
 * copy is not a peer to merge with: it seeds the shared one the first time,
 * and stays as the mirror that keeps the screen working with no network.
 *
 * An **empty** shared copy is a value and not an absence — it is how
 * clearing a filter on one device reaches the others — so it wins like any
 * other. Only a missing one lets local through, which is also why nothing
 * here needs a clock: there is never a merge to arbitrate.
 */
export function reconcileCalendarSettings(
	shared: CalendarSettings | null,
	local: CalendarSettings,
): CalendarSettingsReconciliation {
	if (shared !== null) return { settings: shared, push: false };
	return isRemembered(local)
		? { settings: local, push: true }
		: { settings: DEFAULT_CALENDAR_SETTINGS, push: false };
}

export function saveCalendarSettings(
	storage: Pick<SettingsStorage, 'setItem'>,
	settings: CalendarSettings,
) {
	try {
		storage.setItem(
			CALENDAR_SETTINGS_KEY,
			JSON.stringify({ version: 1, ...settings }),
		);
	} catch {
		// Best-effort: storage can be full or blocked, and neither is worth
		// losing the screen over.
	}
}
