// @vitest-environment happy-dom

import { BlockNoteEditor, type PartialBlock } from '@blocknote/core';
import { renderMermaid } from '@web/lib/mermaid';
import { MERMAID_PREVIEW_DEBOUNCE_MS } from '@web/lib/notes-mermaid';
import { type NotesEditor, notesSchema } from '@web/lib/notes-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mermaid lays diagrams out with a real rendering engine, which happy-dom is
// not. The renderer is faked so the tests cover what is ours: which blocks get
// a preview, when it re-renders and what it shows when the source is broken.
vi.mock('@web/lib/mermaid', () => ({
	renderMermaid: vi.fn(async (source: string) =>
		source.includes('boom')
			? { kind: 'invalid' as const, message: 'Parse error on line 2' }
			: { kind: 'ok' as const, svg: `<svg data-source="${source}"></svg>` },
	),
}));

const FLOWCHART = 'flowchart TD\n  A --> B';

let mounted: { editor: NotesEditor; root: HTMLElement } | undefined;

function mountNote(
	content: PartialBlock<typeof notesSchema.blockSchema>[],
	options: { editable?: boolean } = {},
) {
	const editor = BlockNoteEditor.create({
		schema: notesSchema,
		initialContent: content,
		...options,
	});
	const root = document.createElement('div');
	document.body.appendChild(root);
	editor.mount(root);
	mounted = { editor, root };
	return { editor, root };
}

function codeBlock(language: string, code: string) {
	return { type: 'codeBlock', props: { language }, content: code } as const;
}

function previewOf(root: HTMLElement, language: string) {
	return root.querySelector(
		`[data-content-type="codeBlock"][data-language="${language}"] + .notes-mermaid-preview`,
	);
}

function viewOf(root: HTMLElement) {
	return root
		.querySelector('.notes-mermaid-preview')
		?.getAttribute('data-view');
}

function toggleOf(root: HTMLElement) {
	const button = root.querySelector('.notes-mermaid-toggle');
	if (!(button instanceof HTMLButtonElement)) throw new Error('no toggle');
	return button;
}

function renderedSource(root: HTMLElement, language = 'mermaid') {
	return previewOf(root, language)
		?.querySelector('svg')
		?.getAttribute('data-source');
}

afterEach(() => {
	mounted?.editor.unmount();
	mounted?.root.remove();
	mounted = undefined;
	vi.mocked(renderMermaid).mockClear();
});

describe('mermaid previews in Notes', () => {
	it('draws a mermaid code block below its source and leaves other languages alone', async () => {
		const { root } = mountNote([
			codeBlock('mermaid', FLOWCHART),
			codeBlock('typescript', 'const a = 1;'),
		]);

		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));
		// The source stays readable next to the drawing.
		expect(root.textContent).toContain('flowchart TD');
		expect(previewOf(root, 'typescript')).toBeNull();
	});

	it('draws in a read-only editor, which is what history and public notes mount', async () => {
		const { root } = mountNote([codeBlock('mermaid', FLOWCHART)], {
			editable: false,
		});
		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));
	});

	it('re-renders once for a burst of edits, after the pause', async () => {
		const { editor, root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));
		const block = editor.document[0];
		if (!block) throw new Error('missing block');

		editor.updateBlock(block, { content: 'flowchart LR\n  A' });
		editor.updateBlock(block, { content: 'flowchart LR\n  A --' });
		editor.updateBlock(block, { content: 'flowchart LR\n  A --> C' });

		// Mid-typing sources never reach the renderer.
		await new Promise((resolve) =>
			setTimeout(resolve, MERMAID_PREVIEW_DEBOUNCE_MS / 2),
		);
		expect(renderMermaid).toHaveBeenCalledTimes(1);

		await vi.waitFor(() =>
			expect(renderedSource(root)).toBe('flowchart LR\n  A --> C'),
		);
		expect(renderMermaid).toHaveBeenCalledTimes(2);
	});

	it('keeps the last good drawing while the source is broken, and says so', async () => {
		const { editor, root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));
		const block = editor.document[0];
		if (!block) throw new Error('missing block');

		editor.updateBlock(block, { content: 'flowchart TD\n  boom' });

		await vi.waitFor(() =>
			expect(previewOf(root, 'mermaid')?.textContent).toContain(
				'Invalid diagram',
			),
		);
		expect(previewOf(root, 'mermaid')?.textContent).toContain(
			'Parse error on line 2',
		);
		expect(renderedSource(root)).toBe(FLOWCHART);

		editor.updateBlock(block, { content: 'flowchart TD\n  B --> C' });
		await vi.waitFor(() =>
			expect(renderedSource(root)).toBe('flowchart TD\n  B --> C'),
		);
		expect(previewOf(root, 'mermaid')?.textContent).not.toContain(
			'Invalid diagram',
		);
	});

	it('reports a broken diagram that never rendered without a stale drawing', async () => {
		const { root } = mountNote([codeBlock('mermaid', 'boom')]);
		await vi.waitFor(() =>
			expect(previewOf(root, 'mermaid')?.textContent).toContain(
				'Invalid diagram',
			),
		);
		expect(previewOf(root, 'mermaid')?.querySelector('svg')).toBeNull();
	});

	it('keeps drawing after ProseMirror recreates the plugin views', async () => {
		const { editor, root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		// Reconfiguring the plugin list destroys and recreates every plugin view
		// while the widget elements already in the DOM stay where they are.
		const reconfigure = () => {
			const view = editor.prosemirrorView;
			if (!view) throw new Error('not mounted');
			view.updateState(
				view.state.reconfigure({ plugins: [...view.state.plugins] }),
			);
		};
		reconfigure();
		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));

		const block = editor.document[0];
		if (!block) throw new Error('missing block');
		editor.updateBlock(block, { content: 'flowchart LR\n  A --> Z' });
		reconfigure();
		await vi.waitFor(() =>
			expect(renderedSource(root)).toBe('flowchart LR\n  A --> Z'),
		);
	});

	it('shows the drawing instead of the source once it renders, and toggles between them', async () => {
		const { root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
		expect(toggleOf(root).textContent).toBe('Show code');

		toggleOf(root).click();
		await vi.waitFor(() => expect(viewOf(root)).toBe('code'));
		expect(toggleOf(root).textContent).toBe('Show diagram');

		toggleOf(root).click();
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
	});

	it('zooms the drawing by resizing it, so a wide chart scrolls instead of clipping', async () => {
		vi.mocked(renderMermaid).mockResolvedValueOnce({
			kind: 'ok',
			svg: '<svg viewBox="0 0 400 200" width="100%" style="max-width: 400px;"></svg>',
		});
		const { root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
		const svg = () =>
			root.querySelector('.notes-mermaid-diagram svg') as SVGElement;
		const button = (name: string) => {
			const found = root.querySelector(
				`.notes-mermaid-preview button[aria-label="${name}"]`,
			);
			if (!(found instanceof HTMLButtonElement)) throw new Error(name);
			return found;
		};
		expect(svg().style.width).toBe('');

		button('Zoom in').click();
		expect(svg().style.width).toBe('500px');
		expect(svg().style.maxWidth).toBe('none');

		button('Zoom in').click();
		expect(svg().style.width).toBe('625px');

		button('Reset zoom').click();
		expect(svg().style.width).toBe('');
		expect(svg().style.maxWidth).toBe('400px');

		button('Zoom out').click();
		expect(svg().style.width).toBe('320px');
	});

	it('shows the source while the caret is inside the block, and the drawing again when it leaves', async () => {
		const { editor, root } = mountNote([
			codeBlock('mermaid', FLOWCHART),
			{ type: 'paragraph', content: 'after' },
		]);
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
		const [code, paragraph] = editor.document;
		if (!code || !paragraph) throw new Error('missing blocks');

		editor.setTextCursorPosition(code, 'start');
		editor.focus();
		await vi.waitFor(() => expect(viewOf(root)).toBe('code'));

		editor.setTextCursorPosition(paragraph, 'start');
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
	});

	it('has nothing but the source to show until a first drawing exists', async () => {
		const { editor, root } = mountNote([codeBlock('mermaid', 'boom')]);
		await vi.waitFor(() =>
			expect(previewOf(root, 'mermaid')?.textContent).toContain(
				'Invalid diagram',
			),
		);
		expect(viewOf(root)).toBe('code');

		const block = editor.document[0];
		if (!block) throw new Error('missing block');
		editor.updateBlock(block, { content: FLOWCHART });
		await vi.waitFor(() => expect(viewOf(root)).toBe('diagram'));
	});

	it('removes the preview when the block stops being mermaid', async () => {
		const { editor, root } = mountNote([codeBlock('mermaid', FLOWCHART)]);
		await vi.waitFor(() => expect(renderedSource(root)).toBe(FLOWCHART));
		const block = editor.document[0];
		if (!block) throw new Error('missing block');

		editor.updateBlock(block, { props: { language: 'typescript' } });

		await vi.waitFor(() =>
			expect(root.querySelector('.notes-mermaid-preview')).toBeNull(),
		);
	});
});
