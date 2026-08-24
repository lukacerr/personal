import {
	createViewPreferences,
	DEFAULT_VIEW_PREFERENCES,
	type ViewPreferenceSize,
	type ViewPreferences,
} from '@web/lib/view-preferences';

export type NotesPreferenceSize = ViewPreferenceSize;
export type NotesPreferences = ViewPreferences;

export const NOTES_PREFERENCES_KEY = 'personal-notes-view:v1';
export const DEFAULT_NOTES_PREFERENCES: NotesPreferences =
	DEFAULT_VIEW_PREFERENCES;

const notesPreferences = createViewPreferences(NOTES_PREFERENCES_KEY);

export const loadNotesPreferences = notesPreferences.load;
export const saveNotesPreferences = notesPreferences.save;
export const useNotesPreferences = notesPreferences.usePreferences;
