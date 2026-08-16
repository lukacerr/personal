import {
	buildNoteTree,
	collectFolderPaths,
	getActiveFolderPath,
	getLastSelectedNoteId,
	getNoteMoveResult,
	hasDuplicateNoteTitle,
	isDeleteBlockShortcut,
	isNewNoteShortcut,
	isNoteFindShortcut,
	isNoteReplaceShortcut,
	isNoteSaveShortcut,
	isNotesTreeShortcut,
	nextAvailableNoteTitle,
	rememberSelectedNote,
	searchNotes,
} from '@web/lib/notes';
import type { NoteSummary } from '@web/lib/notes-db';
import { describe, expect, it } from 'vitest';

const note = (id: string, title: string, path: string | null): NoteSummary => ({
	id,
	title,
	path,
	isPublic: false,
	viewCount: 0,
	createdAt: 1,
	updatedAt: 1,
});

describe('Notes', () => {
	it('matches each shortcut only on its exact modifier combination', () => {
		const press = (
			overrides: Partial<Parameters<typeof isNoteSaveShortcut>[0]>,
		) => ({
			key: 'x',
			ctrlKey: true,
			metaKey: false,
			altKey: false,
			shiftKey: false,
			repeat: false,
			...overrides,
		});

		const shortcuts = [
			{ match: isNoteSaveShortcut, key: 's' },
			{ match: isNoteFindShortcut, key: 'f' },
			{ match: isNoteReplaceShortcut, key: 'h' },
			{ match: isDeleteBlockShortcut, key: 'd' },
			{ match: isNewNoteShortcut, key: 'n' },
			{ match: isNotesTreeShortcut, key: 'b', altKey: true },
		];

		for (const { match, key, altKey = false } of shortcuts) {
			expect(match(press({ key, altKey }))).toBe(true);
			expect(match(press({ key: key.toUpperCase(), altKey }))).toBe(true);

			// Every shortcut needs Ctrl, rejects Meta and auto-repeat, and owns its key.
			expect(match(press({ key, altKey, ctrlKey: false }))).toBe(false);
			expect(match(press({ key, altKey, metaKey: true }))).toBe(false);
			expect(match(press({ key, altKey, repeat: true }))).toBe(false);
			expect(match(press({ key: 'z', altKey }))).toBe(false);

			// Alt distinguishes the tree shortcut from the rest.
			expect(match(press({ key, altKey: !altKey }))).toBe(false);
		}

		// Save tolerates Shift because some browsers swallow a plain Ctrl+S.
		expect(isNoteSaveShortcut(press({ key: 's', shiftKey: true }))).toBe(true);
		for (const { match, key, altKey = false } of shortcuts.filter(
			({ key: shortcutKey }) => shortcutKey !== 's',
		))
			expect(match(press({ key, altKey, shiftKey: true }))).toBe(false);
	});

	it('builds sorted folders from note paths without persisting empty folders', () => {
		const tree = buildNoteTree([
			note('3', 'Zeta', 'work/projects'),
			note('1', 'Root', null),
			note('2', 'Alpha', 'work'),
		]);

		expect(tree.notes.map((item) => item.title)).toEqual(['Root']);
		expect(tree.folders[0]?.name).toBe('work');
		expect(tree.folders[0]?.notes.map((item) => item.title)).toEqual(['Alpha']);
		expect(tree.folders[0]?.folders[0]?.path).toBe('work/projects');
	});

	it('enforces case-insensitive naming within each folder', () => {
		const notes = [
			note('1', 'Untitled', null),
			note('2', 'untitled 2', null),
			note('3', 'Untitled', 'work'),
		];

		expect(nextAvailableNoteTitle(notes, null)).toBe('Untitled 3');
		expect(nextAvailableNoteTitle(notes, 'work')).toBe('Untitled 2');
		const titled = [
			note('1', 'Launch Plan', 'work'),
			note('2', 'Launch Plan', 'personal'),
		];
		expect(hasDuplicateNoteTitle(titled, '3', ' launch plan ', 'work')).toBe(
			true,
		);
		expect(hasDuplicateNoteTitle(titled, '1', 'Launch Plan', 'work')).toBe(
			false,
		);
		expect(
			hasDuplicateNoteTitle(titled, '3', 'Launch Plan', 'personal/new'),
		).toBe(false);
	});

	it('marks only the direct containing folder as active', () => {
		const notes = [note('nested', 'Plan', 'work/projects')];

		expect(getActiveFolderPath(notes, 'nested')).toBe('work/projects');
		expect(getActiveFolderPath(notes, 'missing')).toBeUndefined();
	});

	it('collects every derived folder path for expand and collapse all', () => {
		const tree = buildNoteTree([
			note('1', 'Plan', 'work/projects'),
			note('2', 'Journal', 'personal'),
		]);

		expect(collectFolderPaths(tree)).toEqual([
			'personal',
			'work',
			'work/projects',
		]);
	});

	it('resolves folder and root moves without allowing no-ops or conflicts', () => {
		const notes = [
			note('moving', 'Plan', 'work'),
			note('conflict', 'plan', 'personal'),
		];

		expect(getNoteMoveResult(notes, 'moving', 'archive')).toEqual({
			status: 'move',
			path: 'archive',
		});
		expect(getNoteMoveResult(notes, 'moving', null)).toEqual({
			status: 'move',
			path: null,
		});
		expect(getNoteMoveResult(notes, 'moving', 'WORK')).toEqual({
			status: 'same',
		});
		expect(getNoteMoveResult(notes, 'moving', 'PERSONAL')).toEqual({
			status: 'conflict',
		});
	});

	it('restores the last selected note and falls back when it no longer exists', () => {
		let stored: string | null = 'second';
		const storage = {
			getItem: () => stored,
			setItem: (_key: string, value: string) => {
				stored = value;
			},
		};
		const notes = [
			note('first', 'First', null),
			note('second', 'Second', null),
		];

		expect(getLastSelectedNoteId(notes, storage)).toBe('second');
		stored = 'deleted';
		expect(getLastSelectedNoteId(notes, storage)).toBe('first');
		expect(getLastSelectedNoteId([], storage)).toBeNull();
		rememberSelectedNote(storage, 'first');
		expect(stored).toBe('first');
	});
});

describe('Note search', () => {
	const notes = [
		{ title: 'Shopping list', path: null },
		{ title: 'Meeting notes', path: 'work/2026' },
		{ title: 'Recipes', path: 'personal' },
	];

	it('matches a title however it was cased', () => {
		expect(searchNotes(notes, 'SHOPPING').map((note) => note.title)).toEqual([
			'Shopping list',
		]);
	});

	/** A note three folders down is a match on its own terms. */
	it('matches on the folder a note lives in', () => {
		expect(searchNotes(notes, 'work').map((note) => note.title)).toEqual([
			'Meeting notes',
		]);
	});

	it('answers an empty query with nothing, so the tree stays the tree', () => {
		expect(searchNotes(notes, '   ')).toEqual([]);
	});

	it('matches part of a word, not just its start', () => {
		expect(searchNotes(notes, 'cipe').map((note) => note.title)).toEqual([
			'Recipes',
		]);
	});
});
