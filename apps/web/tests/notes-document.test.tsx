// @vitest-environment happy-dom

import 'fake-indexeddb/auto';
import type { Block } from '@blocknote/core';
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteDocument } from '@web/components/notes/note-document';
import { type LocalNote, notesDb } from '@web/lib/notes-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findCommands = vi.hoisted(() => ({
	setSearchTerm: vi.fn(),
	setReplaceTerm: vi.fn(),
	replace: vi.fn(),
	replaceAll: vi.fn(),
	goToNextResult: vi.fn(),
	goToPreviousResult: vi.fn(),
	clearSearch: vi.fn(),
}));

const editor = vi.hoisted(() => ({
	document: [
		{
			id: 'block-1',
			type: 'paragraph',
			props: {
				backgroundColor: 'default',
				textAlignment: 'left',
				textColor: 'default',
			},
			content: [{ type: 'text', text: 'Saved', styles: {} }],
			children: [],
		},
	] as Block[],
	replaceBlocks: vi.fn(),
	getTextCursorPosition: vi.fn(),
	insertBlocks: vi.fn(),
	removeBlocks: vi.fn(),
	setTextCursorPosition: vi.fn(),
	focus: vi.fn(),
	_tiptapEditor: {
		storage: {
			findAndReplace: {
				searchTerm: '',
				replaceTerm: '',
				results: [],
				currentIndex: null,
			},
		},
		commands: findCommands,
	},
}));

vi.mock('@blocknote/core/extensions', () => ({
	filterSuggestionItems: vi.fn(() => []),
}));

vi.mock('@blocknote/react', () => ({
	getDefaultReactSlashMenuItems: vi.fn(() => []),
	SuggestionMenuController: () => null,
	useCreateBlockNote: () => editor,
	useEditorState: ({
		selector,
	}: {
		selector: (value: { editor: typeof editor }) => unknown;
	}) => selector({ editor }),
}));

vi.mock('@blocknote/shadcn', () => ({
	BlockNoteView: ({ formattingToolbar }: { formattingToolbar?: boolean }) => (
		<div
			data-testid="blocknote"
			data-formatting-toolbar={String(formattingToolbar)}
		/>
	),
}));

vi.mock('@web/lib/authenticated-api', () => ({
	authenticatedApi: {},
}));

vi.mock('@web/lib/notes-preferences', () => ({
	useNotesPreferences: () => ({
		preferences: { fontSize: 'medium', margins: 'medium' },
		setPreference: vi.fn(),
	}),
}));

vi.mock('@web/lib/notes-sync', () => ({
	fetchRemoteNote: vi.fn(),
	refreshNoteIndex: vi.fn(),
	syncNoteOutbox: vi.fn(),
	updateAndSyncNoteMetadata: vi.fn(async () => true),
}));

const note: LocalNote = {
	id: 'note-1',
	title: 'Saved note',
	path: null,
	createdAt: 1,
	updatedAt: 1,
	content: editor.document,
	dirty: false,
};

describe('NoteDocument', () => {
	beforeEach(async () => {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: vi.fn(() => ({ matches: true })),
		});
		editor.replaceBlocks.mockClear();
		editor.getTextCursorPosition.mockReturnValue({ block: editor.document[0] });
		editor.insertBlocks.mockReturnValue([
			{ ...editor.document[0], id: 'inserted' },
		]);
		editor.removeBlocks.mockClear();
		editor.setTextCursorPosition.mockClear();
		editor.focus.mockClear();
		for (const command of Object.values(findCommands)) command.mockClear();
		await notesDb.delete();
		await notesDb.open();
		await notesDb.notes.put(note);
		Object.defineProperty(navigator, 'onLine', {
			configurable: true,
			value: false,
		});
	});

	afterEach(async () => {
		cleanup();
		await notesDb.delete();
	});

	it('does not turn a saved note back into a draft when it unmounts', async () => {
		const user = userEvent.setup();
		const view = render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(async () =>
			expect(await notesDb.notes.get(note.id)).toMatchObject({ dirty: false }),
		);

		view.unmount();

		await waitFor(async () =>
			expect(await notesDb.notes.get(note.id)).toMatchObject({ dirty: false }),
		);
	});

	it('focuses the editor when an existing note opens', async () => {
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await waitFor(() => expect(editor.focus).toHaveBeenCalledOnce());
	});

	it('keeps focus in the title for a newly created note', async () => {
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('textbox', { name: 'Note title' }),
			),
		);
		expect(editor.focus).not.toHaveBeenCalled();
	});

	it('does not autofocus an existing note on a coarse pointer', async () => {
		vi.mocked(window.matchMedia).mockReturnValue({
			matches: false,
		} as MediaQueryList);
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await Promise.resolve();
		expect(editor.focus).not.toHaveBeenCalled();
	});

	it('still focuses a new note title on a coarse pointer', async () => {
		vi.mocked(window.matchMedia).mockReturnValue({
			matches: false,
		} as MediaQueryList);
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('textbox', { name: 'Note title' }),
			),
		);
	});

	it('applies a newer remote snapshot to the mounted editor without creating a draft', async () => {
		const remoteContent = [
			{
				...editor.document[0],
				id: 'remote-block',
				content: [{ type: 'text', text: 'Remote', styles: {} }],
			},
		] as Block[];
		const view = render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		view.rerender(
			<NoteDocument
				note={{
					...note,
					title: 'Remote title',
					path: 'remote/path',
					updatedAt: 2,
					content: remoteContent,
				}}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await waitFor(() =>
			expect(editor.replaceBlocks).toHaveBeenCalledWith(
				editor.document,
				remoteContent,
			),
		);
		expect(
			(screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement)
				.value,
		).toBe('Remote title');
		expect(
			(screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement)
				.value,
		).toBe('remote/path');
		expect(await notesDb.notes.get(note.id)).toMatchObject({ dirty: false });
	});

	it('applies metadata drafts created from the file tree to the mounted header', async () => {
		const view = render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		view.rerender(
			<NoteDocument
				note={{
					...note,
					title: 'Renamed in tree',
					dirty: true,
					draftUpdatedAt: 2,
				}}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await waitFor(() =>
			expect(
				(
					screen.getByRole('textbox', {
						name: 'Note title',
					}) as HTMLInputElement
				).value,
			).toBe('Renamed in tree'),
		);
	});

	it('handles block keyboard and clipboard actions inside the editor', () => {
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);
		const editorElement = screen.getByTestId('blocknote').parentElement;
		if (!editorElement) throw new Error('Missing editor container');

		fireEvent.keyDown(editorElement, { key: 'd', ctrlKey: true });
		expect(editor.replaceBlocks).toHaveBeenCalledWith(
			[editor.document[0]],
			[{ type: 'paragraph' }],
		);

		const values = new Map<string, string>();
		const clipboardData = {
			getData: (type: string) => values.get(type) ?? '',
			setData: (type: string, value: string) => values.set(type, value),
		};
		fireEvent.copy(editorElement, { clipboardData });
		fireEvent.paste(editorElement, { clipboardData });

		expect(editor.insertBlocks).toHaveBeenCalledWith(
			expect.any(Array),
			editor.document[0],
			'after',
		);
	});

	it('opens and closes find with Ctrl+F and Escape', async () => {
		const user = userEvent.setup();
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await user.keyboard('{Control>}f{/Control}');
		const input = screen.getByRole('searchbox', { name: 'Find in note' });
		expect(document.activeElement).toBe(input);
		const blockNote = screen.getByTestId('blocknote');
		expect(blockNote.dataset.formattingToolbar).toBe('false');
		expect(blockNote.parentElement?.className).not.toContain('pt-');
		// The panel floats: it must not add spacers or padding that move the document.
		expect(blockNote.parentElement?.children.length).toBe(1);
		await user.keyboard('{Escape}');
		expect(
			screen.queryByRole('searchbox', { name: 'Find in note' }),
		).toBeNull();
		expect(findCommands.clearSearch).toHaveBeenCalledOnce();
		expect(editor.focus).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId('blocknote').dataset.formattingToolbar).toBe(
			'true',
		);
	});

	it('pulls the server state from the navbar refresh button', async () => {
		const user = userEvent.setup();
		const onRefresh = vi.fn(async () => undefined);
		const { rerender } = render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={onRefresh}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		const button = screen.getByRole('button', { name: 'Refresh from server' });
		await user.click(button);
		expect(onRefresh).toHaveBeenCalledOnce();

		rerender(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing
				onRefresh={onRefresh}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);
		const busy = screen.getByRole('button', { name: 'Refresh from server' });
		expect(busy.getAttribute('aria-busy')).toBe('true');
		expect(busy.hasAttribute('disabled')).toBe(true);
	});

	it('opens find from the touch-accessible navbar button', async () => {
		const user = userEvent.setup();
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'Find in note' }));
		expect(
			screen.getByRole('searchbox', { name: 'Find in note' }),
		).toBeTruthy();
		expect(screen.queryByRole('textbox', { name: 'Replace with' })).toBeNull();
	});

	it('opens find and replace with Ctrl+H', async () => {
		const user = userEvent.setup();
		render(
			<NoteDocument
				note={note}
				preferences={{ fontSize: 'medium', margins: 'medium' }}
				focusTitle={false}
				treeOpen
				refreshing={false}
				onRefresh={vi.fn()}
				onTitleFocused={vi.fn()}
				onRequestDelete={vi.fn()}
				isTitleTaken={() => false}
			/>,
		);

		await user.keyboard('{Control>}h{/Control}');
		expect(
			screen.getByRole('searchbox', { name: 'Find in note' }),
		).toBeTruthy();
		expect(screen.getByRole('textbox', { name: 'Replace with' })).toBeTruthy();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(
			screen.queryByRole('searchbox', { name: 'Find in note' }),
		).toBeNull();
	});
});
