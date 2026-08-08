import type { Block } from '@blocknote/core';
import {
	centerCurrentFindResult,
	copyCurrentBlock,
	cutCurrentBlock,
	deleteCurrentBlock,
	NOTE_BLOCK_CLIPBOARD_TYPE,
	type NoteSyncState,
	noteCompactStatusLabel,
	noteStatusLabel,
	pasteCopiedBlock,
} from '@web/lib/notes-editor';
import { describe, expect, it, vi } from 'vitest';

const block: Block = {
	id: 'source',
	type: 'heading',
	props: {
		backgroundColor: 'default',
		level: 2,
		textAlignment: 'left',
		textColor: 'default',
	},
	content: [{ type: 'text', text: 'Heading', styles: { bold: true } }],
	children: [
		{
			id: 'child',
			type: 'paragraph',
			props: {
				backgroundColor: 'default',
				textAlignment: 'left',
				textColor: 'default',
			},
			content: [{ type: 'text', text: 'Child', styles: {} }],
			children: [],
		},
	],
};

function clipboard(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getData: (type: string) => values.get(type) ?? '',
		setData: (type: string, value: string) => values.set(type, value),
		values,
	};
}

function editor(document: Block[] = [block]) {
	return {
		document,
		getTextCursorPosition: vi.fn(() => ({ block })),
		insertBlocks: vi.fn(() => [{ ...block, id: 'inserted' }]),
		removeBlocks: vi.fn(),
		replaceBlocks: vi.fn(),
		setTextCursorPosition: vi.fn(),
	};
}

describe('Notes block clipboard', () => {
	it('copies and appends a complete block with fresh IDs when no text is selected', () => {
		const data = clipboard();
		const sourceEditor = editor();

		expect(copyCurrentBlock(sourceEditor, data, false)).toBe(true);
		expect(copyCurrentBlock(sourceEditor, data, true)).toBe(false);
		expect(data.values.get('text/plain')).toBe('Heading\nChild');

		const targetEditor = editor();
		expect(pasteCopiedBlock(targetEditor, data)).toBe(true);
		expect(targetEditor.insertBlocks).toHaveBeenCalledWith(
			[
				{
					type: block.type,
					props: block.props,
					content: block.content,
					children: [
						{
							type: block.children[0].type,
							props: block.children[0].props,
							content: block.children[0].content,
							children: [],
						},
					],
				},
			],
			block,
			'after',
		);
		expect(targetEditor.setTextCursorPosition).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'inserted' }),
			'end',
		);
	});

	it('copies an equation as its LaTeX source', () => {
		const data = clipboard();
		const equation = {
			id: 'equation',
			type: 'equation',
			props: { latex: 'e = mc^2' },
			content: undefined,
			children: [],
		} as unknown as Block;
		const sourceEditor = editor([equation]);
		sourceEditor.getTextCursorPosition.mockReturnValue({ block: equation });

		copyCurrentBlock(sourceEditor, data, false);

		expect(data.values.get('text/plain')).toBe('e = mc^2');
	});

	it('keeps an inline equation in the copied plain text', () => {
		const data = clipboard();
		const paragraph = {
			id: 'paragraph',
			type: 'paragraph',
			props: {},
			content: [
				{ type: 'text', text: 'Euler: ', styles: {} },
				{ type: 'latex', props: { latex: 'e^{i\\pi} + 1 = 0' } },
				{ type: 'text', text: ' holds', styles: {} },
			],
			children: [],
		} as unknown as Block;
		const sourceEditor = editor([paragraph]);
		sourceEditor.getTextCursorPosition.mockReturnValue({ block: paragraph });

		copyCurrentBlock(sourceEditor, data, false);

		expect(data.values.get('text/plain')).toBe(
			'Euler: $e^{i\\pi} + 1 = 0$ holds',
		);
	});

	it('cuts the whole block only when no text is selected', () => {
		const data = clipboard();
		const targetEditor = editor([
			block,
			{ ...block, id: 'another', children: [] },
		]);

		// Selected text belongs to the browser: cutting it must not take the block.
		expect(cutCurrentBlock(targetEditor, data, true)).toBe(false);
		expect(targetEditor.removeBlocks).not.toHaveBeenCalled();
		expect(data.values.get(NOTE_BLOCK_CLIPBOARD_TYPE)).toBeUndefined();

		expect(cutCurrentBlock(targetEditor, data, false)).toBe(true);
		expect(targetEditor.removeBlocks).toHaveBeenCalledWith([block]);
	});

	it('ignores ordinary text clipboard data', () => {
		expect(
			pasteCopiedBlock(editor(), clipboard({ 'text/plain': 'ordinary text' })),
		).toBe(false);
		expect(NOTE_BLOCK_CLIPBOARD_TYPE).toContain('personal');
	});

	it('keeps an editable empty block when deleting the only root block', () => {
		const targetEditor = editor();

		deleteCurrentBlock(targetEditor);

		expect(targetEditor.removeBlocks).not.toHaveBeenCalled();
		expect(targetEditor.replaceBlocks).toHaveBeenCalledWith(
			[block],
			[{ type: 'paragraph' }],
		);
	});
});

describe('Notes editor presentation', () => {
	it('centers the active find result in the editor viewport', () => {
		const scrollIntoView = vi.fn();
		const root = {
			querySelector: vi.fn(() => ({ scrollIntoView })),
		};
		const schedule = vi.fn((callback: () => void) => callback());

		centerCurrentFindResult(root, schedule);

		expect(root.querySelector).toHaveBeenCalledWith(
			'.find-and-replace-result-current',
		);
		expect(scrollIntoView).toHaveBeenCalledWith({
			block: 'center',
			inline: 'nearest',
		});
	});

	it('labels every sync state in both full and compact form', () => {
		const states: NoteSyncState[] = [
			'saving',
			'rejected',
			'failed',
			'pending',
			'offline',
			'draft',
			'synced',
		];

		for (const state of states) {
			expect(noteStatusLabel(state, 'Title already taken')).not.toBe('');
			expect(
				noteStatusLabel(state, 'Title already taken').length,
			).toBeGreaterThan(noteCompactStatusLabel(state).length - 1);
		}
		// A server rejection carries its reason in full, and stays terse when compact.
		expect(noteStatusLabel('rejected', 'Title already taken')).toBe(
			'Title already taken',
		);
		expect(noteCompactStatusLabel('rejected')).toBe('Rejected');
		expect(noteStatusLabel('synced', undefined)).toBe('Synced');
		expect(noteCompactStatusLabel('synced')).toBe('Synced');
	});
});
