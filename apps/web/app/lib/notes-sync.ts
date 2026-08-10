import { authenticatedApi } from '@web/lib/authenticated-api';
import {
	cacheRemoteNote,
	createNoteOutboxSynchronizer,
	enqueueNoteMetadata,
	type NoteDetail,
	type NoteMetadata,
	type NoteMetadataPatch,
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

/**
 * The API stores a note document as opaque JSON and never reads a block's type,
 * so an equation crosses it unchanged. Its contract is nonetheless typed with
 * BlockNote's default schema, which has no equation block, and this request is
 * the single place where the two views of the same document have to meet.
 */
function toApiContent(content: NoteSaveOperation['content']) {
	return content as unknown as NoteDetail['content'];
}

async function sendNoteSave(operation: NoteSaveOperation): Promise<NoteDetail> {
	const response = await authenticatedApi
		.notes({ id: operation.noteId })
		.mutations.post({
			title: operation.title,
			path: operation.path,
			createdAt: operation.createdAt,
			content: toApiContent(operation.content),
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
			isPublic: operation.isPublic,
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
	patch: NoteMetadataPatch,
) {
	await enqueueNoteMetadata(notesDb, id, patch);
	if (!navigator.onLine) return false;
	try {
		await syncNoteOutbox();
		return true;
	} catch {
		return false;
	}
}

/**
 * What the server last called the index, so a refresh that changed nothing
 * costs a round trip and no payload. Held in memory rather than persisted: a
 * cold start has no cached summaries to validate it against anyway.
 */
let noteIndexTag: string | undefined;

export async function refreshNoteIndex() {
	await syncNoteOutbox();
	// Through `fetch` rather than `headers`: Eden types the latter as the one
	// header its own contract knows about, and this one is the browser's.
	const response = await authenticatedApi.notes.get(
		noteIndexTag
			? { fetch: { headers: { 'if-none-match': noteIndexTag } } }
			: {},
	);
	if (response.status === 304) return;
	if (
		response.status !== 200 ||
		!response.data ||
		!Array.isArray(response.data)
	)
		throw new NotesApiError(response.status);

	noteIndexTag = response.response.headers.get('etag') ?? undefined;
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
