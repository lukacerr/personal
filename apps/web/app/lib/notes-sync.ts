import { authenticatedApi } from '@web/lib/authenticated-api';
import {
	cacheRemoteNote,
	createNoteOutboxSynchronizer,
	enqueueNoteMetadata,
	type NoteDetail,
	type NoteMetadata,
	type NoteOutboxOperation,
	type NoteSaveOperation,
	notesDb,
	reconcileNoteSummaries,
} from '@web/lib/notes-db';
import { createNotesRefresh } from '@web/lib/notes-refresh';

const terminalMessages: Record<number, string> = {
	404: 'This note no longer exists on the server.',
	409: 'Another note already uses this title in this folder.',
	422: 'The server rejected this note as invalid.',
};

class NotesApiError extends Error {
	/**
	 * Client errors other than timeouts and rate limits will fail identically on
	 * every retry, so the outbox drops them instead of stalling behind them.
	 */
	readonly terminal: boolean;

	constructor(readonly status: number) {
		super(terminalMessages[status] ?? `Notes API returned ${status}`);
		this.terminal =
			status >= 400 && status < 500 && status !== 408 && status !== 429;
	}
}

async function sendNoteSave(operation: NoteSaveOperation): Promise<NoteDetail> {
	const response = await authenticatedApi
		.notes({ id: operation.noteId })
		.mutations.post({
			title: operation.title,
			path: operation.path,
			createdAt: operation.createdAt,
			content: operation.content,
		});

	if (
		response.status !== 201 ||
		!response.data ||
		!('content' in response.data)
	)
		throw new NotesApiError(response.status);

	return response.data;
}

async function sendNoteMetadata(
	operation: Exclude<NoteOutboxOperation, NoteSaveOperation>,
): Promise<NoteMetadata> {
	const response = await authenticatedApi
		.notes({ id: operation.noteId })
		.patch({
			title: operation.title,
			path: operation.path,
		});

	if (response.status !== 200 || !response.data || !('title' in response.data))
		throw new NotesApiError(response.status);

	return response.data;
}

async function sendNoteOperation(operation: NoteOutboxOperation) {
	return operation.type === 'save'
		? sendNoteSave(operation)
		: sendNoteMetadata(operation);
}

const synchronizeOutbox = createNoteOutboxSynchronizer(
	notesDb,
	sendNoteOperation,
);

export function syncNoteOutbox() {
	return synchronizeOutbox();
}

export async function updateAndSyncNoteMetadata(
	id: string,
	metadata: { title: string; path: string | null },
) {
	await enqueueNoteMetadata(notesDb, id, metadata);
	if (!navigator.onLine) return false;
	try {
		await syncNoteOutbox();
		return true;
	} catch {
		return false;
	}
}

export async function refreshNoteIndex() {
	await syncNoteOutbox();
	const response = await authenticatedApi.notes.get();
	if (
		response.status !== 200 ||
		!response.data ||
		!Array.isArray(response.data)
	)
		throw new NotesApiError(response.status);

	await reconcileNoteSummaries(notesDb, response.data);
}

/**
 * The only manual entry point: the automatic triggers never fire while the app
 * stays open and focused, so edits made from another device need this.
 */
export const refreshNotes = createNotesRefresh({
	syncOutbox: syncNoteOutbox,
	refreshIndex: refreshNoteIndex,
	fetchNote: fetchRemoteNote,
	getNoteState: async (id) => {
		const [note, pendingCount] = await Promise.all([
			notesDb.notes.get(id),
			notesDb.outbox.where('noteId').equals(id).count(),
		]);
		return note ? { dirty: Boolean(note.dirty), pendingCount } : undefined;
	},
	isOnline: () => navigator.onLine,
});

export async function fetchRemoteNote(id: string) {
	const response = await authenticatedApi.notes({ id }).get();
	if (
		response.status !== 200 ||
		!response.data ||
		!('content' in response.data)
	)
		throw new NotesApiError(response.status);

	await cacheRemoteNote(notesDb, response.data);
	return response.data;
}
