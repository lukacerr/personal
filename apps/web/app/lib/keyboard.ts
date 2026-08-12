/**
 * Whether the key that was pressed already belongs to whatever holds focus.
 *
 * Every shortcut the app claims is a key some editor or input claims too, so
 * this is the one condition they all share. It asks about the editable target
 * and not about the selection: with a collapsed caret an editor still applies
 * the key to whatever gets typed next, which is the common case a selection
 * check misses.
 */
export function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.isContentEditable ||
		target.tagName === 'INPUT' ||
		target.tagName === 'TEXTAREA'
	);
}

/** The fields every shortcut predicate reads, so a test can hand over a literal. */
export type ShortcutEvent = Pick<
	KeyboardEvent,
	'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'shiftKey' | 'target'
>;
