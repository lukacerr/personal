export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 384;

type SidebarShortcutEvent = Pick<
	KeyboardEvent,
	'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'shiftKey'
>;

export function isAppSidebarShortcut(
	event: SidebarShortcutEvent,
	hasTextSelection = false,
) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		!hasTextSelection &&
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
