// @vitest-environment happy-dom

import { BlockNoteEditor, type PartialBlock } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/shadcn';
import { cleanup, render } from '@testing-library/react';
import { NoteMathExtension, pasteWithMath } from '@web/lib/notes-editor';
import { protectPastedMath } from '@web/lib/notes-math';
import { type NoteBlock, notesSchema } from '@web/lib/notes-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Mounted through the real React view: the inline equation is a React node
 * view, and a bare ProseMirror mount has no renderer for it.
 */
function mountNote(content: PartialBlock<typeof notesSchema.blockSchema>[]) {
	const editor = BlockNoteEditor.create({
		schema: notesSchema,
		initialContent: content,
		extensions: [NoteMathExtension],
	});
	render(<BlockNoteView editor={editor} />);
	const first = editor.document[0];
	if (!first) throw new Error('empty note');
	editor.setTextCursorPosition(first, 'end');
	return editor;
}

afterEach(cleanup);

/** Inline content of a block as a compact list of what each piece is. */
function pieces(block: NoteBlock) {
	if (!Array.isArray(block.content)) return [];
	return block.content.map((item) => {
		if (item.type === 'text') return `text:${item.text}`;
		if (item.type === 'latex') return `latex:${item.props.latex}`;
		return item.type;
	});
}

describe('pasting markdown math', () => {
	it('turns dollar-wrapped inline math into equations and leaves prose as text', () => {
		const editor = mountNote([{ type: 'paragraph', content: '' }]);
		editor.pasteHTML('<p>Bisección: $x^3-x-2$ en $[1,2]$ (hecho arriba)</p>');

		expect(pieces(editor.document[0] as NoteBlock)).toEqual([
			'text:Bisección: ',
			'latex:x^3-x-2',
			'text: en ',
			'latex:[1,2]',
			'text: (hecho arriba)',
		]);
	});

	it('keeps currency alone: dollars that do not hug their content stay text', () => {
		const editor = mountNote([{ type: 'paragraph', content: '' }]);
		editor.pasteHTML('<p>cuesta $5 y $10 pesos</p>');

		expect(pieces(editor.document[0] as NoteBlock)).toEqual([
			'text:cuesta $5 y $10 pesos',
		]);
	});

	it('turns a paragraph holding only display math into an equation block', () => {
		const editor = mountNote([{ type: 'paragraph', content: 'Antes' }]);
		editor.pasteHTML(
			"<p>La fórmula:</p><p>$$x_{n+1}=x_n-\\frac{f(x_n)}{f'(x_n)}$$</p><p>Después</p>",
		);

		const document = editor.document as NoteBlock[];
		const equation = document.find((block) => block.type === 'equation');
		expect(equation?.type === 'equation' && equation.props.latex).toBe(
			"x_{n+1}=x_n-\\frac{f(x_n)}{f'(x_n)}",
		);
		expect(document.map((block) => block.type)).toEqual([
			'paragraph',
			'equation',
			'paragraph',
		]);
	});

	it('reads display math that markdown spread over several lines', () => {
		const editor = mountNote([{ type: 'paragraph', content: '' }]);
		editor.pasteMarkdown('$$\nx = 1\n$$');

		const equation = (editor.document as NoteBlock[]).find(
			(block) => block.type === 'equation',
		);
		expect(equation?.type === 'equation' && equation.props.latex).toBe('x = 1');
	});

	it('converts display math that sits mid-sentence inline rather than dropping it', () => {
		const editor = mountNote([{ type: 'paragraph', content: '' }]);
		editor.pasteHTML('<p>o sea $$e^x$$ y listo</p>');

		expect(pieces(editor.document[0] as NoteBlock)).toEqual([
			'text:o sea ',
			'latex:e^x',
			'text: y listo',
		]);
	});

	it('leaves code alone, where a dollar is a dollar', () => {
		const editor = mountNote([
			{
				type: 'codeBlock',
				props: { language: 'shellscript' },
				content: 'echo ',
			},
		]);
		editor.pasteHTML('<p>$HOME$</p>');

		const block = editor.document[0] as NoteBlock;
		expect(block.type).toBe('codeBlock');
		expect(pieces(block)).toEqual(['text:echo $HOME$']);
	});
});

describe('protecting math from the markdown parser', () => {
	it('escapes the punctuation markdown would eat inside a formula and nothing outside', () => {
		expect(
			protectPastedMath('Sea $x_{n+1}=x_n-\\frac{a}{b}$ y *listo* con $a*b$'),
		).toBe('Sea $x\\_{n+1}=x\\_n-\\\\frac{a}{b}$ y *listo* con $a\\*b$');
	});

	it('gives a whole-line display equation its own paragraph', () => {
		expect(protectPastedMath('Iterar:\n$$x_{n+1}=x_n$$\nListo')).toBe(
			'Iterar:\n\n$$x\\_{n+1}=x\\_n$$\n\nListo',
		);
	});

	it('leaves text without math untouched', () => {
		const text = 'Cuesta $5 y $10 pesos, con _énfasis_';
		expect(protectPastedMath(text)).toBe(text);
	});
});

describe('routing a paste that carries math', () => {
	function paste(types: Record<string, string>, blockType = 'paragraph') {
		const defaultPasteHandler = vi.fn(() => true);
		const editor = {
			pasteMarkdown: vi.fn(),
			getTextCursorPosition: () => ({ block: { type: blockType } }),
		};
		const event = {
			clipboardData: {
				types: Object.keys(types),
				getData: (type: string) => types[type] ?? '',
			},
		} as unknown as ClipboardEvent;
		const handled = pasteWithMath({
			event,
			editor: editor as never,
			defaultPasteHandler,
		});
		return { handled, defaultPasteHandler, editor };
	}

	it('keeps HTML ahead of markdown when both carry math, so no parser touches the formulas', () => {
		const { defaultPasteHandler, editor } = paste({
			'text/plain': '**Bisección**: $x_{n+1}$',
			'text/html': '<p><strong>Bisección</strong>: $x_{n+1}$</p>',
		});
		expect(defaultPasteHandler).toHaveBeenCalledWith({
			prioritizeMarkdownOverHTML: false,
		});
		expect(editor.pasteMarkdown).not.toHaveBeenCalled();
	});

	it('pastes plain-only markdown with its math protected', () => {
		const { handled, defaultPasteHandler, editor } = paste({
			'text/plain': 'Sea $x_n$',
		});
		expect(handled).toBe(true);
		expect(defaultPasteHandler).not.toHaveBeenCalled();
		expect(editor.pasteMarkdown).toHaveBeenCalledWith('Sea $x\\_n$');
	});

	it('steps aside without math, inside code, or for anything richer than text', () => {
		for (const [types, blockType] of [
			[{ 'text/plain': 'sin fórmulas, $5 y $10' }, 'paragraph'],
			[{ 'text/plain': 'echo $HOME$' }, 'codeBlock'],
			[{ 'text/plain': '$x$', 'vscode-editor-data': '{}' }, 'paragraph'],
		] as const) {
			const { defaultPasteHandler, editor } = paste({ ...types }, blockType);
			expect(defaultPasteHandler).toHaveBeenCalledWith();
			expect(editor.pasteMarkdown).not.toHaveBeenCalled();
		}
	});

	it('survives the markdown parser end to end: underscores stay, emphasis outside still works', () => {
		const editor = mountNote([{ type: 'paragraph', content: '' }]);
		editor.pasteMarkdown(protectPastedMath('Sea $x_{n+1}=x_n$ y *listo*'));

		const block = editor.document[0] as NoteBlock;
		expect(pieces(block)).toEqual([
			'text:Sea ',
			'latex:x_{n+1}=x_n',
			'text: y ',
			'text:listo',
		]);
		expect(
			Array.isArray(block.content) &&
				block.content.some(
					(item) =>
						item.type === 'text' && item.text === 'listo' && item.styles.italic,
				),
		).toBe(true);
	});
});
