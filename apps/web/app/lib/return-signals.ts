/**
 * The DOM signals that mean a person is at the machine right now.
 *
 * `pointermove` earns its place: the case this exists for is a window that
 * stayed visible and focused for an hour while nobody was in the room, where
 * `visibilitychange` and `focus` never fire and moving the mouse is the only
 * evidence anyone came back.
 */
const ACTIVITY_EVENTS = [
	'pointerdown',
	'pointermove',
	'keydown',
	'wheel',
	'touchstart',
] as const;

/**
 * Why the app is being asked to catch up.
 *
 * `activity` is somebody being here, which only makes what is on screen
 * *possibly* old. `reconnect` is a stronger claim: work that could not leave
 * the device now can, and nothing else will notice that on its own.
 */
export type ReturnSignalReason = 'activity' | 'reconnect';

/** Attaches the client-side signals that mean someone returned to the app. */
export function listenForReturnSignals(
	signal: (reason: ReturnSignalReason) => void,
) {
	const onActivity = () => signal('activity');
	const onReconnect = () => signal('reconnect');
	const onVisible = () => {
		if (document.visibilityState === 'visible') signal('activity');
	};
	for (const type of ACTIVITY_EVENTS)
		document.addEventListener(type, onActivity, {
			passive: true,
			capture: true,
		});
	window.addEventListener('focus', onActivity);
	window.addEventListener('online', onReconnect);
	document.addEventListener('visibilitychange', onVisible);

	return () => {
		for (const type of ACTIVITY_EVENTS)
			document.removeEventListener(type, onActivity, { capture: true });
		window.removeEventListener('focus', onActivity);
		window.removeEventListener('online', onReconnect);
		document.removeEventListener('visibilitychange', onVisible);
	};
}
