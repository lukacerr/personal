import {
	DEFAULT_NOTES_PREFERENCES,
	loadNotesPreferences,
	saveNotesPreferences,
} from '@web/lib/notes-preferences';
import { describe, expect, it } from 'vitest';

function memoryStorage(initial?: string) {
	let value = initial ?? null;
	return {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
}

describe('Notes preferences', () => {
	it('persists valid per-device choices and falls back safely', () => {
		const storage = memoryStorage();
		saveNotesPreferences(storage, { fontSize: 'large', margins: 'small' });

		expect(loadNotesPreferences(storage)).toEqual({
			fontSize: 'large',
			margins: 'small',
		});
		expect(loadNotesPreferences(memoryStorage('{invalid'))).toEqual(
			DEFAULT_NOTES_PREFERENCES,
		);
		expect(
			loadNotesPreferences(
				memoryStorage(
					JSON.stringify({ version: 1, fontSize: 'huge', margins: 'small' }),
				),
			),
		).toEqual(DEFAULT_NOTES_PREFERENCES);
	});
});
