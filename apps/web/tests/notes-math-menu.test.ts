import { mathSlashMenuItems } from '@web/components/notes/note-math';
import { describe, expect, it, vi } from 'vitest';

function mathEditor() {
	const block = { id: 'block-1', type: 'paragraph' };
	return {
		block,
		insertInlineContent: vi.fn(),
		updateBlock: vi.fn(),
		getTextCursorPosition: vi.fn(() => ({ block })),
	};
}

function itemFor(editor: ReturnType<typeof mathEditor>, title: string) {
	const item = mathSlashMenuItems(editor as never).find(
		(candidate) => candidate.title === title,
	);
	if (!item) throw new Error(`No slash menu item titled "${title}"`);
	return item;
}

describe('Notes math slash menu', () => {
	/** Inline content is inserted as a list; a bare node throws at runtime. */
	it('inserts an inline equation through the inline content API', () => {
		const editor = mathEditor();

		itemFor(editor, 'Inline equation').onItemClick();

		expect(editor.insertInlineContent).toHaveBeenCalledWith([
			{ type: 'latex', props: { latex: '' } },
		]);
	});

	it('turns the current block into a display equation', () => {
		const editor = mathEditor();

		itemFor(editor, 'Equation').onItemClick();

		expect(editor.updateBlock).toHaveBeenCalledWith(editor.block, {
			type: 'equation',
			props: { latex: '' },
		});
	});

	/** A grouped item keeps the menu from rendering a nameless, keyless section. */
	it('files every item under a named menu group', () => {
		expect(
			mathSlashMenuItems(mathEditor() as never).map((item) => item.group),
		).toEqual(['Math', 'Math']);
	});
});
