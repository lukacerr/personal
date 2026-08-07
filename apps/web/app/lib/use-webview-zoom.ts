import {
	nextZoomLevel,
	ZOOM_DEFAULT,
	type ZoomIntent,
	zoomIntentFromKey,
	zoomIntentFromWheel,
} from '@web/lib/webview-zoom';
import { useEffect } from 'react';

type TauriInternals = {
	invoke: (command: string, payload?: unknown) => Promise<unknown>;
};

function getTauriInternals(): TauriInternals | null {
	if (typeof window === 'undefined') return null;
	const internals = (window as { __TAURI_INTERNALS__?: TauriInternals })
		.__TAURI_INTERNALS__;
	return internals && typeof internals.invoke === 'function' ? internals : null;
}

/**
 * Browser-style zoom for the Tauri desktop shell.
 *
 * Tauri's Linux zoom-hotkey polyfill runs in an isolated JavaScript world and
 * cannot reach `window.__TAURI_INTERNALS__` on the remote page, so its `invoke`
 * silently fails. This hook runs in the page's main world, in the capture phase
 * (so editors and other handlers can't swallow the shortcut), and drives the
 * webview zoom directly.
 *
 * It probes the `set_webview_zoom` command once on mount and only binds the
 * shortcuts if that command is actually granted for this webview. Outside Tauri,
 * or on platforms/origins where the capability is not granted (so the native
 * zoom still works), it is a no-op and leaves the event handling untouched.
 */
export function useWebviewZoom() {
	useEffect(() => {
		const internals = getTauriInternals();
		if (!internals) return;

		let level = ZOOM_DEFAULT;
		let disposed = false;
		let detach: (() => void) | undefined;

		const apply = (intent: ZoomIntent) => {
			level = nextZoomLevel(level, intent);
			void internals.invoke('plugin:webview|set_webview_zoom', {
				value: level,
			});
		};

		const onKeyDown = (event: KeyboardEvent) => {
			const intent = zoomIntentFromKey(event);
			if (!intent) return;
			// Own the gesture: prevent the browser default and stop Tauri's
			// bubble-phase zoom polyfill from double-handling it.
			event.preventDefault();
			event.stopPropagation();
			apply(intent);
		};

		const onWheel = (event: WheelEvent) => {
			const intent = zoomIntentFromWheel(event);
			if (!intent) return;
			event.preventDefault();
			event.stopPropagation();
			apply(intent);
		};

		// Probe the command first: if it is not granted the promise rejects and
		// we never bind, so native zoom keeps working on other platforms.
		void internals
			.invoke('plugin:webview|set_webview_zoom', { value: ZOOM_DEFAULT })
			.then(() => {
				if (disposed) return;
				window.addEventListener('keydown', onKeyDown, { capture: true });
				window.addEventListener('wheel', onWheel, {
					capture: true,
					passive: false,
				});
				detach = () => {
					window.removeEventListener('keydown', onKeyDown, { capture: true });
					window.removeEventListener('wheel', onWheel, { capture: true });
				};
			})
			.catch(() => {});

		return () => {
			disposed = true;
			detach?.();
		};
	}, []);
}
