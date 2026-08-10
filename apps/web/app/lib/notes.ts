import type { NoteSummary } from '@web/lib/notes-db';

const LAST_SELECTED_NOTE_KEY = 'personal-notes-selection:v1';

type NoteSelectionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function getLastSelectedNoteId(
	notes: NoteSummary[],
	storage: Pick<NoteSelectionStorage, 'getItem'>,
) {
	if (notes.length === 0) return null;
	try {
		const remembered = storage.getItem(LAST_SELECTED_NOTE_KEY);
		return notes.some((note) => note.id === remembered)
			? remembered
			: notes[0].id;
	} catch {
		return notes[0].id;
	}
}

export function rememberSelectedNote(
	storage: Pick<NoteSelectionStorage, 'setItem'>,
	id: string,
) {
	try {
		storage.setItem(LAST_SELECTED_NOTE_KEY, id);
	} catch {
		// Selection persistence is best-effort when storage is unavailable.
	}
}

export type NoteTreeFolder = {
	name: string;
	path: string;
	folders: NoteTreeFolder[];
	notes: NoteSummary[];
};

type NoteKeyEvent = Pick<
	KeyboardEvent,
	'ctrlKey' | 'key' | 'repeat' | 'shiftKey'
> & {
	altKey?: boolean;
	metaKey?: boolean;
};

/**
 * Every Notes shortcut requires Ctrl, rejects Meta and auto-repeat, and matches
 * its key case-insensitively. `alt` and `shift` are stated per shortcut because
 * that is the only thing that actually varies between them; `'any'` means the
 * modifier is ignored rather than forbidden.
 */
function matchesShortcut(
	event: NoteKeyEvent,
	key: string,
	modifiers: { alt?: boolean; shift?: boolean | 'any' } = {},
) {
	const { alt = false, shift = false } = modifiers;
	return (
		event.ctrlKey &&
		!event.metaKey &&
		!event.repeat &&
		Boolean(event.altKey) === alt &&
		(shift === 'any' || event.shiftKey === shift) &&
		event.key.toLowerCase() === key
	);
}

// Some browsers, Vivaldi among them, swallow a plain Ctrl+S, so Shift is ignored.
export const isNoteSaveShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 's', { shift: 'any' });

export const isNoteFindShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 'f');

export const isNoteReplaceShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 'h');

export const isDeleteBlockShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 'd');

export const isNotesTreeShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 'b', { alt: true });

export const isNewNoteShortcut = (event: NoteKeyEvent) =>
	matchesShortcut(event, 'n');

export function nextAvailableNoteTitle(
	notes: Pick<NoteSummary, 'path' | 'title'>[],
	path: string | null,
) {
	const normalizedPath = (path ?? '').toLocaleLowerCase();
	const titles = new Set(
		notes
			.filter(
				(note) => (note.path ?? '').toLocaleLowerCase() === normalizedPath,
			)
			.map((note) => note.title.toLocaleLowerCase()),
	);

	let suffix = 1;
	while (titles.has(suffix === 1 ? 'untitled' : `untitled ${suffix}`))
		suffix += 1;
	return suffix === 1 ? 'Untitled' : `Untitled ${suffix}`;
}

export function getActiveFolderPath(
	notes: NoteSummary[],
	selectedId: string | null,
) {
	return notes.find((note) => note.id === selectedId)?.path ?? undefined;
}

export function collectFolderPaths(folder: NoteTreeFolder): string[] {
	return folder.folders.flatMap((child) => [
		child.path,
		...collectFolderPaths(child),
	]);
}

export function hasDuplicateNoteTitle(
	notes: NoteSummary[],
	id: string,
	title: string,
	path: string | null,
) {
	const normalizedTitle = title.trim().toLocaleLowerCase();
	const normalizedPath = (path ?? '').toLocaleLowerCase();
	return notes.some(
		(note) =>
			note.id !== id &&
			note.title.toLocaleLowerCase() === normalizedTitle &&
			(note.path ?? '').toLocaleLowerCase() === normalizedPath,
	);
}

export function getNoteMoveResult(
	notes: NoteSummary[],
	id: string,
	path: string | null,
) {
	const moving = notes.find((note) => note.id === id);
	if (!moving) return { status: 'missing' } as const;
	if (
		(moving.path ?? '').toLocaleLowerCase() === (path ?? '').toLocaleLowerCase()
	)
		return { status: 'same' } as const;
	if (hasDuplicateNoteTitle(notes, id, moving.title, path))
		return { status: 'conflict' } as const;
	return { status: 'move', path } as const;
}

export function buildNoteTree(notes: NoteSummary[]): NoteTreeFolder {
	const root: NoteTreeFolder = { name: '', path: '', folders: [], notes: [] };

	for (const note of notes) {
		let folder = root;
		for (const part of note.path?.split('/') ?? []) {
			const path = folder.path ? `${folder.path}/${part}` : part;
			let child = folder.folders.find((item) => item.name === part);
			if (!child) {
				child = { name: part, path, folders: [], notes: [] };
				folder.folders.push(child);
			}
			folder = child;
		}
		folder.notes.push(note);
	}

	const sortFolder = (folder: NoteTreeFolder) => {
		folder.folders.sort((left, right) => left.name.localeCompare(right.name));
		folder.notes.sort((left, right) => left.title.localeCompare(right.title));
		for (const child of folder.folders) sortFolder(child);
	};
	sortFolder(root);

	return root;
}

/**
 * Notes matching what someone typed into the tree's search.
 *
 * Searching flattens the tree rather than filtering it in place: a note three
 * folders down is a match on its own terms, and hiding it behind collapsed
 * parents would be answering a different question. The path comes back with it
 * so the result still says where the note lives.
 */
export function searchNotes<T extends { title: string; path: string | null }>(
	notes: T[],
	query: string,
) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [];
	return notes.filter(
		(note) =>
			note.title.toLocaleLowerCase().includes(needle) ||
			note.path?.toLocaleLowerCase().includes(needle),
	);
}
