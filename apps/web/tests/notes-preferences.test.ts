// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import {
	DEFAULT_NOTES_PREFERENCES,
	loadNotesPreferences,
	NOTES_PREFERENCES_KEY,
	saveNotesPreferences,
	useNotesPreferences,
} from '@web/lib/notes-preferences';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
		expect(
			loadNotesPreferences(
				memoryStorage(
					JSON.stringify({ version: 2, fontSize: 'large', margins: 'small' }),
				),
			),
		).toEqual(DEFAULT_NOTES_PREFERENCES);
	});

	// The key is the whole reason Notes and Agent stay separate modules, so it is
	// asserted as a literal rather than through the exported constant.
	it('reads and writes only its own storage key', () => {
		const written: Record<string, string> = {};
		saveNotesPreferences(
			{
				setItem: (key, value) => {
					written[key] = value;
				},
			},
			{ fontSize: 'small', margins: 'large' },
		);

		expect(Object.keys(written)).toEqual(['personal-notes-view:v1']);
		expect(NOTES_PREFERENCES_KEY).toBe('personal-notes-view:v1');

		const read: string[] = [];
		loadNotesPreferences({
			getItem: (key) => {
				read.push(key);
				return written[key] ?? null;
			},
		});
		expect(read).toEqual(['personal-notes-view:v1']);
	});
});

describe('useNotesPreferences', () => {
	// happy-dom leaves `window.localStorage` undefined here, and the hook reads it
	// directly, so the stub goes where the hook looks for it.
	const store = new Map<string, string>();
	const writes: string[] = [];

	beforeEach(() => {
		store.clear();
		writes.length = 0;
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				writes.push(key);
				store.set(key, value);
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Under StrictMode React double-invokes state updater functions, so a single
	// write per change is what proves persisting stayed outside the updater.
	it('persists one write per change, under its own key', () => {
		const { result } = renderHook(() => useNotesPreferences(), {
			wrapper: StrictMode,
		});
		expect(result.current.preferences).toEqual(DEFAULT_NOTES_PREFERENCES);

		act(() => {
			result.current.setPreference('fontSize', 'large');
		});

		expect(result.current.preferences).toEqual({
			fontSize: 'large',
			margins: 'medium',
		});
		expect(writes).toEqual(['personal-notes-view:v1']);
		expect(store.get('personal-notes-view:v1')).toBe(
			JSON.stringify({ version: 1, fontSize: 'large', margins: 'medium' }),
		);
		expect(store.has('personal-agent-view:v1')).toBe(false);
	});
});
