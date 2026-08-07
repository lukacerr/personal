import { useState } from 'react';
import { z } from 'zod';

const notesPreferencesSchema = z.object({
	version: z.literal(1),
	fontSize: z.enum(['small', 'medium', 'large']),
	margins: z.enum(['small', 'medium', 'large']),
});

export type NotesPreferenceSize = 'small' | 'medium' | 'large';
export type NotesPreferences = {
	fontSize: NotesPreferenceSize;
	margins: NotesPreferenceSize;
};

type PreferencesStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const NOTES_PREFERENCES_KEY = 'personal-notes-view:v1';
export const DEFAULT_NOTES_PREFERENCES: NotesPreferences = {
	fontSize: 'medium',
	margins: 'medium',
};

export function loadNotesPreferences(
	storage: Pick<PreferencesStorage, 'getItem'>,
): NotesPreferences {
	try {
		const raw = storage.getItem(NOTES_PREFERENCES_KEY);
		if (!raw) return DEFAULT_NOTES_PREFERENCES;
		const parsed = notesPreferencesSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return DEFAULT_NOTES_PREFERENCES;
		return {
			fontSize: parsed.data.fontSize,
			margins: parsed.data.margins,
		};
	} catch {
		return DEFAULT_NOTES_PREFERENCES;
	}
}

export function saveNotesPreferences(
	storage: Pick<PreferencesStorage, 'setItem'>,
	preferences: NotesPreferences,
) {
	try {
		storage.setItem(
			NOTES_PREFERENCES_KEY,
			JSON.stringify({ version: 1, ...preferences }),
		);
	} catch {
		// Preference persistence is best-effort when storage is full or blocked.
	}
}

export function useNotesPreferences() {
	const [preferences, setPreferencesState] = useState<NotesPreferences>(() =>
		typeof window === 'undefined'
			? DEFAULT_NOTES_PREFERENCES
			: loadNotesPreferences(window.localStorage),
	);

	// Persisting stays outside the updater: React may invoke an updater more than
	// once, and a state updater must not perform side effects.
	const setPreference = (
		key: keyof NotesPreferences,
		value: NotesPreferenceSize,
	) => {
		const next = { ...preferences, [key]: value };
		setPreferencesState(next);
		saveNotesPreferences(window.localStorage, next);
	};

	return { preferences, setPreference };
}
