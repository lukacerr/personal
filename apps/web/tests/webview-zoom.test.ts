import {
	nextZoomLevel,
	ZOOM_DEFAULT,
	ZOOM_MAX,
	ZOOM_MIN,
	zoomIntentFromKey,
	zoomIntentFromWheel,
} from '@web/lib/webview-zoom';
import { describe, expect, it } from 'vitest';

describe('zoomIntentFromKey', () => {
	const base = { ctrlKey: true, metaKey: false, altKey: false };

	it('zooms out on Ctrl + minus (key and numpad)', () => {
		expect(zoomIntentFromKey({ ...base, key: '-' })).toBe('out');
		expect(zoomIntentFromKey({ ...base, key: 'Subtract' })).toBe('out');
	});

	it('zooms in on Ctrl + plus or equals regardless of layout', () => {
		expect(zoomIntentFromKey({ ...base, key: '+' })).toBe('in');
		expect(zoomIntentFromKey({ ...base, key: '=' })).toBe('in');
		expect(zoomIntentFromKey({ ...base, key: 'Add' })).toBe('in');
	});

	it('resets on Ctrl + 0', () => {
		expect(zoomIntentFromKey({ ...base, key: '0' })).toBe('reset');
	});

	it('accepts Cmd as the modifier', () => {
		expect(
			zoomIntentFromKey({
				key: '-',
				ctrlKey: false,
				metaKey: true,
				altKey: false,
			}),
		).toBe('out');
	});

	it('ignores keys without the modifier, with Alt, or unrelated keys', () => {
		expect(
			zoomIntentFromKey({
				key: '-',
				ctrlKey: false,
				metaKey: false,
				altKey: false,
			}),
		).toBeNull();
		expect(zoomIntentFromKey({ ...base, altKey: true, key: '-' })).toBeNull();
		expect(zoomIntentFromKey({ ...base, key: 'a' })).toBeNull();
	});
});

describe('zoomIntentFromWheel', () => {
	const base = { ctrlKey: true, metaKey: false, altKey: false };

	it('zooms in scrolling up and out scrolling down', () => {
		expect(zoomIntentFromWheel({ ...base, deltaY: -1 })).toBe('in');
		expect(zoomIntentFromWheel({ ...base, deltaY: 1 })).toBe('out');
	});

	it('ignores wheel without the modifier or without movement', () => {
		expect(
			zoomIntentFromWheel({
				ctrlKey: false,
				metaKey: false,
				altKey: false,
				deltaY: -1,
			}),
		).toBeNull();
		expect(zoomIntentFromWheel({ ...base, deltaY: 0 })).toBeNull();
	});
});

describe('nextZoomLevel', () => {
	it('steps in and out without floating point drift', () => {
		expect(nextZoomLevel(1, 'in')).toBe(1.1);
		expect(nextZoomLevel(1.1, 'in')).toBe(1.2);
		expect(nextZoomLevel(1, 'out')).toBe(0.9);
	});

	it('clamps to the allowed range', () => {
		expect(nextZoomLevel(ZOOM_MAX, 'in')).toBe(ZOOM_MAX);
		expect(nextZoomLevel(ZOOM_MIN, 'out')).toBe(ZOOM_MIN);
	});

	it('resets to the default level', () => {
		expect(nextZoomLevel(2.4, 'reset')).toBe(ZOOM_DEFAULT);
	});
});
