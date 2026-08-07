export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

export type ZoomIntent = 'in' | 'out' | 'reset';

type ZoomKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>;

type ZoomWheel = Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'deltaY'>;

/**
 * Maps a keyboard event to a zoom intent for the browser-style shortcuts
 * `Ctrl/Cmd` + `-`, `Ctrl/Cmd` + `+`/`=` and `Ctrl/Cmd` + `0`.
 *
 * Layout-tolerant: `+` and `=` (and their numpad `Add`/`Subtract` names) are
 * all accepted, so zooming in works regardless of whether `Shift` is required
 * to type `+` on the active layout.
 */
export function zoomIntentFromKey(event: ZoomKey): ZoomIntent | null {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;

	switch (event.key) {
		case '-':
		case '_':
		case 'Subtract':
			return 'out';
		case '=':
		case '+':
		case 'Add':
			return 'in';
		case '0':
			return 'reset';
		default:
			return null;
	}
}

/** Maps a `Ctrl/Cmd` + wheel gesture to a zoom intent. */
export function zoomIntentFromWheel(event: ZoomWheel): ZoomIntent | null {
	if (!(event.ctrlKey || event.metaKey) || event.altKey || event.deltaY === 0) {
		return null;
	}

	return event.deltaY < 0 ? 'in' : 'out';
}

/** Returns the next zoom level for an intent, clamped to the allowed range. */
export function nextZoomLevel(current: number, intent: ZoomIntent): number {
	if (intent === 'reset') return ZOOM_DEFAULT;

	const delta = intent === 'in' ? ZOOM_STEP : -ZOOM_STEP;
	const raw = current + delta;
	const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));

	// Avoid floating point drift accumulating across steps.
	return Math.round(clamped * 100) / 100;
}
