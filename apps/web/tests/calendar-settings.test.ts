import {
	DEFAULT_CALENDAR_SETTINGS,
	loadCalendarSettings,
	reconcileCalendarSettings,
	saveCalendarSettings,
} from '@web/lib/calendar-settings';
import { describe, expect, it } from 'vitest';

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
}

describe('calendar settings mirror', () => {
	it('round-trips through storage and shrugs off junk', () => {
		const storage = memoryStorage();
		const settings = {
			groups: [{ from: '2026-08-22', to: '2026-08-24', label: '週末' }],
			hiddenTags: ['uade'],
		};

		saveCalendarSettings(storage, settings);
		expect(loadCalendarSettings(storage)).toEqual(settings);

		storage.setItem('personal-calendar-settings:v1', '{broken');
		expect(loadCalendarSettings(storage)).toEqual(DEFAULT_CALENDAR_SETTINGS);
	});

	it('lets the shared copy decide, even an empty one', () => {
		const local = { hiddenTags: ['uade'] };

		// An empty shared copy is a value — how clearing travels — so it wins.
		expect(reconcileCalendarSettings({}, local)).toEqual({
			settings: {},
			push: false,
		});
		expect(reconcileCalendarSettings({ groups: [] }, local).settings).toEqual({
			groups: [],
		});
	});

	it('seeds the shared copy from local only when there is none', () => {
		const local = { hiddenTags: ['uade'] };
		expect(reconcileCalendarSettings(null, local)).toEqual({
			settings: local,
			push: true,
		});
		expect(reconcileCalendarSettings(null, {})).toEqual({
			settings: DEFAULT_CALENDAR_SETTINGS,
			push: false,
		});
	});
});
