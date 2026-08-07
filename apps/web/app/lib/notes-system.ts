import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import type { AppSystem } from '@web/lib/app-systems';
import { notesDb } from '@web/lib/notes-db';
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

	async loadCommands() {
		const notes = await notesDb.notes.orderBy('title').toArray();
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
