import type { authenticatedApi } from '@web/lib/authenticated-api';
import { nextAvailableNoteTitle } from '@web/lib/notes';
import type { NoteBlock } from '@web/lib/notes-schema';
import type { SessionWorkGuard } from '@web/lib/session-work';
import type { TreatyData } from '@web/lib/treaty-data';
import Dexie, { type Table } from 'dexie';

type NotesRoute = ReturnType<typeof authenticatedApi.notes>;

type NoteSummaries = Extract<
	TreatyData<typeof authenticatedApi.notes.get>,
	unknown[]
>;

export type NoteSummary = NoteSummaries[number];
export type NoteDetail = Extract<
	TreatyData<NotesRoute['get']>,
	{ content: unknown }
>;
export type NoteMetadata = Extract<
	TreatyData<NotesRoute['patch']>,
	{ id: string; title: string }
>;

/**
 * A note's row, without its document.
 *
 * The content lives in its own table because everything that lists notes — the
 * tree, the palette, the duplicate-title check — reads every row, and with the
 * document inline that meant deserializing every note's whole body to answer a
 * question about titles.
 */
export type LocalNote = NoteSummary & {
	dirty: boolean;
	draftUpdatedAt?: number;
	serverUpdatedAt?: number;
	/** Set when the server rejected this note's sync in a way retrying cannot fix. */
	syncFailure?: string;
};

/** A note's row with its document attached, for whoever is editing it. */
export type LoadedNote = LocalNote & { content: NoteBlock[] };

export type NoteContent = { id: string; content: NoteBlock[] };

export type NoteSaveOperation = {
	key: string;
	type: 'save';
	noteId: string;
	title: string;
	path: string | null;
	createdAt: number;
	content: NoteBlock[];
};

export type NoteMetadataOperation = {
	key: string;
	type: 'metadata';
	noteId: string;
	title: string;
	path: string | null;
	isPublic: boolean;
	createdAt: number;
};

/**
 * What a caller wants to change, not the whole record. The queued operation is
 * always complete, but building it from the cached note means renaming can
 * never unpublish and publishing can never move a note back out of its folder.
 */
export type NoteMetadataPatch = Partial<{
	title: string;
	path: string | null;
	isPublic: boolean;
}>;

export type NoteOutboxOperation = NoteSaveOperation | NoteMetadataOperation;

export class NotesDatabase extends Dexie {
	notes!: Table<LocalNote, string>;
	noteContent!: Table<NoteContent, string>;
	outbox!: Table<NoteOutboxOperation, string>;

	constructor(name = 'personal-notes:v1') {
		super(name);
		// `dirty` is deliberately not indexed: IndexedDB cannot use booleans as keys.
		this.version(1).stores({
			notes: 'id, title, path, updatedAt',
			outbox: '&key, noteId, createdAt, [noteId+createdAt]',
		});
		this.version(2)
			.stores({
				notes: 'id, title, path, updatedAt',
				noteContent: 'id',
				outbox: '&key, noteId, createdAt, [noteId+createdAt]',
			})
			.upgrade(async (tx) => {
				// Documents move out of the rows they were stored in. Nothing is
				// dropped, so a draft that never synced survives the upgrade.
				const rows = await tx.table('notes').toArray();
				const documents = rows
					.filter((row) => row.content)
					.map((row) => ({ id: row.id, content: row.content }));
				if (documents.length > 0)
					await tx.table('noteContent').bulkPut(documents);
				await tx
					.table('notes')
					.toCollection()
					.modify((note) => {
						note.content = undefined;
					});
			});
	}
}

export const notesDb = new NotesDatabase();

export async function clearLocalNotes() {
	await notesDb.transaction(
		'rw',
		notesDb.notes,
		notesDb.noteContent,
		notesDb.outbox,
		async () => {
			await notesDb.notes.clear();
			await notesDb.noteContent.clear();
			await notesDb.outbox.clear();
		},
	);
}

/** The document of one note, which is the only one anybody ever edits. */
export async function getNoteContent(db: NotesDatabase, id: string) {
	return (await db.noteContent.get(id))?.content;
}

function emptyDocument(): NoteBlock[] {
	return [
		{
			id: crypto.randomUUID(),
			type: 'paragraph',
			props: {
				backgroundColor: 'default',
				textAlignment: 'left',
				textColor: 'default',
			},
			content: [],
			children: [],
		},
	];
}

export async function createLocalNote(
	db: NotesDatabase,
	path: string | null,
	now = Date.now(),
) {
	return db.transaction('rw', db.notes, db.noteContent, async () => {
		const title = nextAvailableNoteTitle(await db.notes.toArray(), path);
		const note: LocalNote = {
			id: crypto.randomUUID(),
			title,
			path,
			isPublic: false,
			viewCount: 0,
			createdAt: now,
			updatedAt: now,
			dirty: true,
			draftUpdatedAt: now,
			serverUpdatedAt: undefined,
		};
		const content = emptyDocument();
		await db.notes.put(note);
		await db.noteContent.put({ id: note.id, content });
		return { ...note, content } satisfies LoadedNote;
	});
}

export async function updateNoteContentDraft(
	db: NotesDatabase,
	id: string,
	content: NoteBlock[],
	now = Date.now(),
) {
	await db.transaction('rw', db.notes, db.noteContent, async () => {
		const updated = await db.notes
			.where('id')
			.equals(id)
			.modify((note) => {
				note.dirty = true;
				note.draftUpdatedAt = Math.max(now, note.draftUpdatedAt ?? 0);
			});
		if (updated === 0) throw new Error(`Cannot draft missing note ${id}`);
		await db.noteContent.put({ id, content });
	});
}

export async function enqueueNoteMetadata(
	db: NotesDatabase,
	id: string,
	patch: NoteMetadataPatch,
	now = Date.now(),
) {
	return db.transaction('rw', db.notes, db.outbox, async () => {
		const local = await db.notes.get(id);
		if (!local) throw new Error(`Cannot update missing note ${id}`);

		const metadata = {
			title: patch.title ?? local.title,
			path: patch.path === undefined ? local.path : patch.path,
			// Notes cached before publishing existed carry no flag at all, and
			// sending `undefined` would fail validation on their first rename.
			isPublic: patch.isPublic ?? local.isPublic ?? false,
		};

		await db.notes
			.where('id')
			.equals(id)
			.modify((note) => {
				note.title = metadata.title;
				note.path = metadata.path;
				note.isPublic = metadata.isPublic;
			});

		if (local.serverUpdatedAt === undefined) return undefined;

		const operation: NoteMetadataOperation = {
			key: `metadata:${id}`,
			type: 'metadata',
			noteId: id,
			...metadata,
			createdAt: now,
		};
		await db.outbox.put(operation);
		return operation;
	});
}

export async function enqueueNoteSave(
	db: NotesDatabase,
	id: string,
	now = Date.now(),
) {
	return db.transaction('rw', db.notes, db.noteContent, db.outbox, async () => {
		const [localNote, stored] = await Promise.all([
			db.notes.get(id),
			db.noteContent.get(id),
		]);
		if (!localNote || !stored)
			throw new Error(`Cannot save unloaded note ${id}`);

		// Must outrank the last confirmed server version too: with a device clock
		// behind the server, `now` alone would queue a save the server buries in
		// history and never surfaces as current content.
		const createdAt = Math.max(
			now,
			localNote.updatedAt + 1,
			(localNote.serverUpdatedAt ?? 0) + 1,
		);
		const operation: NoteSaveOperation = {
			key: `${id}:${createdAt}`,
			type: 'save',
			noteId: id,
			title: localNote.title,
			path: localNote.path,
			createdAt,
			content: structuredClone(stored.content),
		};

		await db.notes
			.where('id')
			.equals(id)
			.modify((note) => {
				note.updatedAt = createdAt;
				note.dirty = false;
				note.draftUpdatedAt = undefined;
				note.syncFailure = undefined;
			});
		await db.outbox.put(operation);
		return operation;
	});
}

export async function cacheRemoteNote(
	db: NotesDatabase,
	remote: NoteDetail,
	isCurrent: SessionWorkGuard = () => true,
) {
	await db.transaction('rw', db.notes, db.noteContent, db.outbox, async () => {
		if (!isCurrent()) return;
		const [local, localContent, pending] = await Promise.all([
			db.notes.get(remote.id),
			db.noteContent.get(remote.id),
			db.outbox.where('noteId').equals(remote.id).toArray(),
		]);
		const latestPending = pending
			.filter(
				(operation): operation is NoteSaveOperation =>
					operation.type === 'save',
			)
			.reduce<NoteSaveOperation | undefined>(
				(latest, operation) =>
					!latest || operation.createdAt > latest.createdAt
						? operation
						: latest,
				undefined,
			);
		const latestMetadata = pending
			.filter(
				(operation): operation is NoteMetadataOperation =>
					operation.type === 'metadata',
			)
			.reduce<NoteMetadataOperation | undefined>(
				(latest, operation) =>
					!latest || operation.createdAt > latest.createdAt
						? operation
						: latest,
				undefined,
			);

		if (latestPending && latestPending.createdAt > remote.updatedAt) return;

		if (
			local?.dirty &&
			(local.draftUpdatedAt ?? local.updatedAt) >= remote.updatedAt
		) {
			await db.notes.put({ ...local, serverUpdatedAt: remote.updatedAt });
			if (!localContent)
				await db.noteContent.put({
					id: remote.id,
					content: remote.content as NoteBlock[],
				});
			return;
		}

		const { content, ...summary } = remote;
		await db.notes.put({
			...summary,
			title: latestMetadata?.title ?? remote.title,
			path: latestMetadata?.path ?? remote.path,
			isPublic: latestMetadata?.isPublic ?? remote.isPublic,
			dirty: false,
			draftUpdatedAt: undefined,
			serverUpdatedAt: remote.updatedAt,
		});
		await db.noteContent.put({
			id: remote.id,
			content: content as NoteBlock[],
		});
	});
}

function renamedPath(path: string | null, from: string, to: string) {
	if (path === null) return null;
	const lowerPath = path.toLocaleLowerCase();
	const lowerFrom = from.toLocaleLowerCase();
	if (lowerPath === lowerFrom) return to;
	if (lowerPath.startsWith(`${lowerFrom}/`))
		return `${to}${path.slice(from.length)}`;
	return path;
}

function isInsideFolder(path: string | null, folder: string) {
	const lowerPath = path?.toLocaleLowerCase();
	const lowerFolder = folder.toLocaleLowerCase();
	return (
		lowerPath === lowerFolder ||
		Boolean(lowerPath?.startsWith(`${lowerFolder}/`))
	);
}

/**
 * Rewrites queued operations alongside the cached notes. A pending metadata
 * operation still carrying the old path would move the note back out of the
 * renamed folder as soon as it drains.
 */
export async function renameLocalFolder(
	db: NotesDatabase,
	from: string,
	to: string,
) {
	await db.transaction('rw', db.notes, db.outbox, async () => {
		for (const note of await db.notes.toArray()) {
			const path = renamedPath(note.path, from, to);
			if (path !== note.path) await db.notes.put({ ...note, path });
		}
		for (const operation of await db.outbox.toArray()) {
			const path = renamedPath(operation.path, from, to);
			if (path !== operation.path) await db.outbox.put({ ...operation, path });
		}
	});
}

export async function deleteLocalFolder(db: NotesDatabase, folder: string) {
	return db.transaction('rw', db.notes, db.noteContent, db.outbox, async () => {
		const deletedIds = (await db.notes.toArray())
			.filter((note) => isInsideFolder(note.path, folder))
			.map((note) => note.id);
		await db.notes.bulkDelete(deletedIds);
		await db.noteContent.bulkDelete(deletedIds);
		for (const id of deletedIds)
			await db.outbox.where('noteId').equals(id).delete();
		return deletedIds;
	});
}

export async function deleteLocalNote(db: NotesDatabase, id: string) {
	await db.transaction('rw', db.notes, db.noteContent, db.outbox, async () => {
		await db.notes.delete(id);
		await db.noteContent.delete(id);
		await db.outbox.where('noteId').equals(id).delete();
	});
}

export async function reconcileNoteSummaries(
	db: NotesDatabase,
	summaries: NoteSummary[],
	isCurrent: SessionWorkGuard = () => true,
) {
	await db.transaction('rw', db.notes, db.noteContent, db.outbox, async () => {
		if (!isCurrent()) return;
		const [locals, pending] = await Promise.all([
			db.notes.toArray(),
			db.outbox.toArray(),
		]);
		const pendingIds = new Set(pending.map((operation) => operation.noteId));
		const serverIds = new Set(summaries.map((summary) => summary.id));

		for (const summary of summaries) {
			const local = locals.find((item) => item.id === summary.id);
			if (local && pendingIds.has(summary.id)) {
				await db.notes.put({ ...local, serverUpdatedAt: summary.updatedAt });
				continue;
			}
			if (local?.dirty) {
				if (summary.updatedAt > (local.draftUpdatedAt ?? local.updatedAt))
					await db.notes.put({
						...local,
						updatedAt: summary.updatedAt,
						serverUpdatedAt: summary.updatedAt,
					});
				else
					await db.notes.put({ ...local, serverUpdatedAt: summary.updatedAt });
				continue;
			}
			// A newer server version makes any cached document stale. Keeping it
			// would let the next local save ship outdated content under a newer
			// timestamp and silently revert whichever device wrote that version.
			if (local && summary.updatedAt > local.updatedAt)
				await db.noteContent.delete(summary.id);
			await db.notes.put({
				...local,
				...summary,
				dirty: false,
				serverUpdatedAt: summary.updatedAt,
			});
		}

		for (const local of locals) {
			if (
				!serverIds.has(local.id) &&
				!local.dirty &&
				!pendingIds.has(local.id)
			) {
				await db.notes.delete(local.id);
				await db.noteContent.delete(local.id);
			}
		}
	});
}

export type NoteSyncFailure = {
	operation: NoteOutboxOperation;
	error: unknown;
};

/**
 * A terminal error is one retrying can never resolve, such as a rejected title
 * conflict. Leaving it queued would stall every later operation forever, so it
 * is dropped and recorded on the note instead.
 */
function isTerminalSyncError(error: unknown) {
	return (
		(error as { terminal?: boolean } | null | undefined)?.terminal === true
	);
}

async function discardOperation(
	db: NotesDatabase,
	{ operation, error }: NoteSyncFailure,
) {
	const reason = error instanceof Error ? error.message : 'Sync was rejected';
	await db.transaction('rw', db.notes, db.outbox, async () => {
		await db.outbox.delete(operation.key);
		await db.notes
			.where('id')
			.equals(operation.noteId)
			.modify((note) => {
				note.syncFailure = reason;
			});
	});
}

export async function flushNoteOutbox(
	db: NotesDatabase,
	send: (operation: NoteOutboxOperation) => Promise<NoteDetail | NoteMetadata>,
	isCurrent: SessionWorkGuard = () => true,
) {
	const operations = await db.outbox.orderBy('createdAt').toArray();
	const discarded: NoteSyncFailure[] = [];

	for (const operation of operations) {
		try {
			const remote = await send(operation);
			if (!isCurrent())
				return { failed: undefined, discarded, cancelled: true };
			if (operation.type === 'save') {
				if (!('content' in remote))
					throw new Error('Save response did not include note content');
				await db.transaction(
					'rw',
					db.notes,
					db.noteContent,
					db.outbox,
					async () => {
						if (!isCurrent()) return;
						await db.outbox.delete(operation.key);
						await cacheRemoteNote(db, remote, isCurrent);
					},
				);
			} else {
				await db.transaction('rw', db.outbox, async () => {
					if (!isCurrent()) return;
					const current = await db.outbox.get(operation.key);
					if (
						current?.type === 'metadata' &&
						current.createdAt === operation.createdAt
					)
						await db.outbox.delete(operation.key);
				});
			}
		} catch (error) {
			const failure = { operation, error };
			if (!isTerminalSyncError(error)) return { failed: failure, discarded };
			await discardOperation(db, failure);
			discarded.push(failure);
		}
	}

	return { failed: undefined, discarded, cancelled: false };
}

export function createNoteOutboxSynchronizer(
	db: NotesDatabase,
	send: (operation: NoteOutboxOperation) => Promise<NoteDetail | NoteMetadata>,
) {
	let activeSync: Promise<NoteSyncFailure[]> | undefined;
	return function synchronize(isCurrent: SessionWorkGuard = () => true) {
		if (activeSync) return activeSync;
		activeSync = (async () => {
			const discarded: NoteSyncFailure[] = [];
			while ((await db.outbox.count()) > 0) {
				const result = await flushNoteOutbox(db, send, isCurrent);
				discarded.push(...result.discarded);
				if (result.cancelled) return discarded;
				if (result.failed) throw result.failed.error;
			}
			return discarded;
		})().finally(() => {
			activeSync = undefined;
		});
		return activeSync;
	};
}
