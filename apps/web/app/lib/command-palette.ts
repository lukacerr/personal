type CommandPaletteShortcut = Pick<
	KeyboardEvent,
	'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'
>;

const COMMAND_PALETTE_HISTORY_KEY = '__personalCommandPalette';

type PaletteHistory = Pick<History, 'back' | 'pushState' | 'state'>;

export function isCommandPaletteHistoryEntry(state: unknown) {
	return (
		typeof state === 'object' &&
		state !== null &&
		(state as Record<string, unknown>)[COMMAND_PALETTE_HISTORY_KEY] === true
	);
}

export function pushCommandPaletteHistory(
	history: Pick<PaletteHistory, 'pushState' | 'state'>,
	href: string,
) {
	if (isCommandPaletteHistoryEntry(history.state)) return false;
	const state =
		typeof history.state === 'object' && history.state !== null
			? history.state
			: {};
	history.pushState(
		{ ...state, [COMMAND_PALETTE_HISTORY_KEY]: true },
		'',
		href,
	);
	return true;
}

export function consumeCommandPaletteHistory(
	history: Pick<PaletteHistory, 'back' | 'state'>,
) {
	if (!isCommandPaletteHistoryEntry(history.state)) return false;
	history.back();
	return true;
}

export function shouldRestorePaletteFocus(reason: 'dismiss' | 'navigate') {
	return reason === 'dismiss';
}

export function isCommandPaletteShortcut(event: CommandPaletteShortcut) {
	return (
		event.key === ' ' &&
		event.ctrlKey &&
		!event.metaKey &&
		!event.altKey &&
		!event.repeat
	);
}
