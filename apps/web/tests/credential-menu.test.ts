import { credentialSlashMenuItems } from '@web/components/notes/note-credential';
import { describe, expect, it, vi } from 'vitest';

/** The menu deletes its query before the item runs, leaving the trigger behind. */
function credentialEditor(text = '/') {
	const block = {
		id: 'block-1',
		type: 'paragraph',
		props: {},
		content: text ? [{ type: 'text', text, styles: {} }] : [],
		children: [],
	};
	const inserted = { id: 'block-2', type: 'credential' };
	return {
		block,
		inserted,
		insertBlocks: vi.fn(() => [inserted]),
		setTextCursorPosition: vi.fn(),
		updateBlock: vi.fn(),
		getTextCursorPosition: vi.fn(() => ({ block })),
	};
}

function credentialItem(editor: ReturnType<typeof credentialEditor>) {
	const item = credentialSlashMenuItems(editor as never)[0];
	if (!item) throw new Error('No credential slash menu item');
	return item;
}

describe('Notes credential slash menu', () => {
	/**
	 * A reference replaces the block it lands on, so it may only take one with
	 * nothing else in it — the trigger the menu left behind does not count.
	 */
	it('takes over the block it was called from when that block is empty', () => {
		const editor = credentialEditor('/');

		credentialItem(editor).onItemClick();

		expect(editor.updateBlock).toHaveBeenCalledWith(
			editor.block,
			expect.objectContaining({ type: 'credential' }),
		);
		expect(editor.insertBlocks).not.toHaveBeenCalled();
	});

	it('adds itself below a line that was already written', () => {
		const editor = credentialEditor('a written line /');

		credentialItem(editor).onItemClick();

		expect(editor.updateBlock).not.toHaveBeenCalled();
		expect(editor.insertBlocks).toHaveBeenCalledWith(
			[expect.objectContaining({ type: 'credential' })],
			editor.block,
			'after',
		);
		expect(editor.setTextCursorPosition).toHaveBeenCalledWith(editor.inserted);
	});

	/** Every entry declares its group, or BlockNote emits a nameless section. */
	it('declares the group it belongs to', () => {
		expect(credentialItem(credentialEditor()).group).toBe('Credentials');
	});

	/**
	 * The block it inserts carries an id and a title and nothing else. A value in a
	 * prop would be written into the note document, every history version, every
	 * delta, and the payload a published note serves to anyone with the link.
	 */
	it('inserts a block whose props cannot hold a value', () => {
		const editor = credentialEditor('/');

		credentialItem(editor).onItemClick();

		const [, reference] = editor.updateBlock.mock.calls[0] as [
			unknown,
			{ props: Record<string, unknown> },
		];
		expect(Object.keys(reference.props).sort()).toEqual([
			'credentialId',
			'title',
		]);
	});
});
