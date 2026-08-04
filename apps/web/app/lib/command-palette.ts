type CommandPaletteShortcut = Pick<
	KeyboardEvent,
	'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'
>;

export function isCommandPaletteShortcut(event: CommandPaletteShortcut) {
	return (
		event.key === ' ' &&
		event.ctrlKey &&
		!event.metaKey &&
		!event.altKey &&
		!event.repeat
	);
}
