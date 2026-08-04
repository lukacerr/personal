export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 384;

export function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function getSidebarTransitionClass(isResizing: boolean) {
	return isResizing
		? 'transition-none'
		: 'transition-[left,right,width] duration-100 ease-linear';
}
