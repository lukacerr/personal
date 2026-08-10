export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 384;

type SidebarShortcutEvent = Pick<
	KeyboardEvent,
	'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'shiftKey' | 'target'
>;

/**
 * Ctrl/Cmd+B is the bold shortcut of every text editor, so the shell only
 * claims it when the key does not already belong to whatever holds focus. The
 * condition is the editable target and not the selection: with a collapsed
 * caret the editor still toggles bold for the next character typed, which is
 * the common case a selection check misses.
 */
function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.isContentEditable ||
		target.tagName === 'INPUT' ||
		target.tagName === 'TEXTAREA'
	);
}

export function isAppSidebarShortcut(event: SidebarShortcutEvent) {
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
