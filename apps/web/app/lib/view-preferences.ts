import { useState } from 'react';
import { z } from 'zod';

/**
 * How a screen renders long-form content — text size and page width — chosen per
 * device and never synced, because the answer belongs to the screen it is being
 * read on and not to the account.
 *
 * Every system that offers these two choices gets its own storage key, so the
 * shape lives here once and the key is what the caller brings.
 */

const viewPreferencesSchema = z.object({
	version: z.literal(1),
	fontSize: z.enum(['small', 'medium', 'large']),
	margins: z.enum(['small', 'medium', 'large']),
});

export type ViewPreferenceSize = 'small' | 'medium' | 'large';
export type ViewPreferences = {
	fontSize: ViewPreferenceSize;
	margins: ViewPreferenceSize;
};

type PreferencesStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
	fontSize: 'medium',
	margins: 'medium',
};

export function createViewPreferences(storageKey: string) {
	function load(storage: Pick<PreferencesStorage, 'getItem'>): ViewPreferences {
		try {
			const raw = storage.getItem(storageKey);
			if (!raw) return DEFAULT_VIEW_PREFERENCES;
			const parsed = viewPreferencesSchema.safeParse(JSON.parse(raw));
			if (!parsed.success) return DEFAULT_VIEW_PREFERENCES;
			return {
				fontSize: parsed.data.fontSize,
				margins: parsed.data.margins,
			};
		} catch {
			return DEFAULT_VIEW_PREFERENCES;
		}
	}

	function save(
		storage: Pick<PreferencesStorage, 'setItem'>,
		preferences: ViewPreferences,
	) {
		try {
			storage.setItem(
				storageKey,
				JSON.stringify({ version: 1, ...preferences }),
			);
		} catch {
			// Preference persistence is best-effort when storage is full or blocked.
		}
	}

	function usePreferences() {
		const [preferences, setPreferencesState] = useState<ViewPreferences>(() =>
			typeof window === 'undefined'
				? DEFAULT_VIEW_PREFERENCES
				: load(window.localStorage),
		);

		// Persisting stays outside the updater: React may invoke an updater more
		// than once, and a state updater must not perform side effects.
		const setPreference = (
			key: keyof ViewPreferences,
			value: ViewPreferenceSize,
		) => {
			const next = { ...preferences, [key]: value };
			setPreferencesState(next);
			save(window.localStorage, next);
		};

		return { preferences, setPreference };
	}

	return { load, save, usePreferences };
}
