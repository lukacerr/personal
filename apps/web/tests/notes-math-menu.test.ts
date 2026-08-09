import { mathSlashMenuItems } from '@web/components/notes/note-math';
import { describe, expect, it, vi } from 'vitest';

/** The menu deletes its query before the item runs, leaving the trigger behind. */
function mathEditor(text = '/') {
	const block = {
		id: 'block-1',
		type: 'paragraph',
		props: {},
		content: text ? [{ type: 'text', text, styles: {} }] : [],
		children: [],
	};
	const inserted = { id: 'block-2', type: 'equation' };
	return {
		block,
		inserted,
		insertInlineContent: vi.fn(),
		insertBlocks: vi.fn(() => [inserted]),
		setTextCursorPosition: vi.fn(),
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

	it.each(['/', ''])(
		'turns a block holding only %s into a display equation',
		(text) => {
			const editor = mathEditor(text);

			itemFor(editor, 'Equation').onItemClick();

			expect(editor.updateBlock).toHaveBeenCalledWith(editor.block, {
				type: 'equation',
				props: { latex: '' },
			});
			expect(editor.insertBlocks).not.toHaveBeenCalled();
		},
	);

	/**
	 * A display equation replaces its whole block, so taking over one that still
	 * holds text would delete it — the same rule the `$$` shorthand already obeys.
	 */
	it('adds the equation after a block that still holds text', () => {
		const editor = mathEditor('/keep me');

		itemFor(editor, 'Equation').onItemClick();

		expect(editor.updateBlock).not.toHaveBeenCalled();
		expect(editor.insertBlocks).toHaveBeenCalledWith(
			[{ type: 'equation', props: { latex: '' } }],
			editor.block,
			'after',
		);
		expect(editor.setTextCursorPosition).toHaveBeenCalledWith(editor.inserted);
	});

	/** A grouped item keeps the menu from rendering a nameless, keyless section. */
	it('files every item under a named menu group', () => {
		expect(
			mathSlashMenuItems(mathEditor() as never).map((item) => item.group),
		).toEqual(['Math', 'Math']);
	});
});
