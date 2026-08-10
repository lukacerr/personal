import { fileSlashMenuItems } from '@web/components/notes/note-file';
import { describe, expect, it, vi } from 'vitest';

/** The menu deletes its query before the item runs, leaving the trigger behind. */
function fileEditor(text = '/') {
	const block = {
		id: 'block-1',
		type: 'paragraph',
		props: {},
		content: text ? [{ type: 'text', text, styles: {} }] : [],
		children: [],
	};
	const inserted = { id: 'block-2', type: 'storedFile' };
	return {
		block,
		inserted,
		insertBlocks: vi.fn(() => [inserted]),
		setTextCursorPosition: vi.fn(),
		updateBlock: vi.fn(),
		getTextCursorPosition: vi.fn(() => ({ block })),
	};
}

function attachItem(editor: ReturnType<typeof fileEditor>) {
	const item = fileSlashMenuItems(editor as never)[0];
	if (!item) throw new Error('No file slash menu item');
	return item;
}

describe('Notes file slash menu', () => {
	/**
	 * An attachment replaces the block it lands on, so it may only take one with
	 * nothing else in it — the trigger the menu left behind does not count.
	 */
	it('takes over the block it was called from when that block is empty', () => {
		const editor = fileEditor('/');

		attachItem(editor).onItemClick();

		expect(editor.updateBlock).toHaveBeenCalledWith(
			editor.block,
			expect.objectContaining({ type: 'storedFile' }),
		);
		expect(editor.insertBlocks).not.toHaveBeenCalled();
	});

	it('adds itself below a line that was already written', () => {
		const editor = fileEditor('a written line /');

		attachItem(editor).onItemClick();

		expect(editor.updateBlock).not.toHaveBeenCalled();
		expect(editor.insertBlocks).toHaveBeenCalledWith(
			[expect.objectContaining({ type: 'storedFile' })],
			editor.block,
			'after',
		);
		expect(editor.setTextCursorPosition).toHaveBeenCalledWith(editor.inserted);
	});

	/** Every entry declares its group, or BlockNote emits a nameless section. */
	it('declares the group it belongs to', () => {
		expect(attachItem(fileEditor()).group).toBe('Files');
	});
});
