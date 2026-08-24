import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import { clearLocalNotes, notesDb } from '@web/lib/notes-db';
import { refreshNotes } from '@web/lib/notes-sync';
import { FileTextIcon, FolderIcon } from 'lucide-react';

const NOTES_PATH = '/notes';

/** Folder segments carry their cumulative path: a name can repeat at other depths. */
export function noteBreadcrumbTrail(note: {
	title: string;
	path: string | null;
}): AppBreadcrumbItem[] {
	const folders = note.path ? note.path.split('/') : [];
	return [
		...folders.map((label, depth) => ({
			key: `folder:${folders.slice(0, depth + 1).join('/')}`,
			label,
			icon: FolderIcon,
		})),
		{ key: 'note', label: note.title, icon: FileTextIcon },
	];
}

export const notesSystem: AppSystem = {
	key: 'notes',
	heading: 'Notes',
	icon: FileTextIcon,

	/** Pulls the index at startup, so the palette can offer notes from anywhere. */
	// The palette queries note titles from every screen.
	refreshEverywhere: true,

	/**
	 * The open note comes along, and `refreshNotes` decides whether it may be
	 * replaced: a note with an unsaved draft or queued operations is left alone,
	 * so this can never overwrite what is being typed.
	 */
	async refresh(search, isCurrent) {
		const selected = new URLSearchParams(search).get('note') ?? undefined;
		const result = await refreshNotes(selected, isCurrent);
		return result.status === 'refreshed';
	},

	/** Notes are private; sign-out leaves none of them on the device. */
	clearLocalData: clearLocalNotes,

	/**
	 * Scans the rows rather than an index because a person searching for a note
	 * means a substring of its title, which no IndexedDB index can answer. The
	 * rows are small now — the documents live in their own table — so the scan
	 * reads titles and paths and nothing else.
	 */
	async searchCommands(query, limit) {
		const notes = await notesDb.notes
			.orderBy('title')
			.filter((note) => matchesCommandQuery(query, note.title, note.path))
			.limit(limit)
			.toArray();
		return notes.map((note) => ({
			id: note.id,
			label: note.title,
			detail: note.path ?? 'Root',
			to: `${NOTES_PATH}?note=${note.id}`,
		}));
	},

	async loadBreadcrumbTrail(pathname, search) {
		if (pathname !== NOTES_PATH) return [];
		const selectedId = new URLSearchParams(search).get('note');
		if (!selectedId) return [];
		const note = await notesDb.notes.get(selectedId);
		return note ? noteBreadcrumbTrail(note) : [];
	},
};
