import { isEditableTarget, type ShortcutEvent } from '@web/lib/keyboard';

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 384;

/**
 * Ctrl/Cmd+B is the bold shortcut of every text editor, so the shell only
 * claims it when the key does not already belong to whatever holds focus.
 */
export function isAppSidebarShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		!isEditableTarget(event.target) &&
		event.key.toLowerCase() === 'b'
	);
}

export function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function getSidebarTransitionClass(isResizing: boolean) {
	return isResizing
		? 'transition-none'
		: 'transition-[left,right,width] duration-75 ease-linear motion-reduce:transition-none';
}
