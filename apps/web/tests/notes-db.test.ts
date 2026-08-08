import 'fake-indexeddb/auto';
import type { Block } from '@blocknote/core';
import {
	cacheRemoteNote,
	createLocalNote,
	createNoteOutboxSynchronizer,
	enqueueNoteMetadata,
	enqueueNoteSave,
	flushNoteOutbox,
	type LocalNote,
	NotesDatabase,
	reconcileNoteSummaries,
	updateNoteContentDraft,
} from '@web/lib/notes-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const content = (text: string) =>
	[
		{
			id: crypto.randomUUID(),
			type: 'paragraph',
			props: {
				backgroundColor: 'default',
				textAlignment: 'left',
				textColor: 'default',
			},
			content: [{ type: 'text', text, styles: {} }],
			children: [],
		},
	] as Block[];

describe('NotesDatabase', () => {
	let db: NotesDatabase;

	beforeEach(() => {
		db = new NotesDatabase(`personal-notes-test-${crypto.randomUUID()}`);
	});

	afterEach(async () => {
		await db.delete();
	});

	it('persists drafts without adding them to the server outbox', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Draft',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			content: content('Saved'),
			dirty: false,
		});

		await updateNoteContentDraft(db, 'note-1', content('Unsaved'));

		expect(await db.notes.get('note-1')).toMatchObject({ dirty: true });
		expect(await db.outbox.count()).toBe(0);
	});

	it('creates an unsynced Untitled note in the requested folder', async () => {
		await db.notes.put({
			id: 'existing',
			title: 'Untitled',
			path: 'work',
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			dirty: false,
		});

		const created = await createLocalNote(db, 'work', 100);

		expect(created).toMatchObject({
			title: 'Untitled 2',
			path: 'work',
			createdAt: 100,
			updatedAt: 100,
			dirty: true,
		});
		expect(created.content).toHaveLength(1);
		await enqueueNoteMetadata(
			db,
			created.id,
			{
				title: 'Local only',
				path: 'personal',
			},
			101,
		);
		expect(await db.notes.get(created.id)).toMatchObject({
			title: 'Local only',
			path: 'personal',
			dirty: true,
			serverUpdatedAt: undefined,
		});
		expect(await db.outbox.count()).toBe(0);
	});

	it('coalesces metadata and keeps a newer change made while syncing', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Saved',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 10,
			content: content('Saved'),
			dirty: false,
		});
		await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'First', path: 'work' },
			100,
		);
		await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'Second', path: 'work' },
			101,
		);
		let releaseRequest: () => void = () => undefined;
		const requestBlocked = new Promise<void>((resolve) => {
			releaseRequest = resolve;
		});
		let requestStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});

		const flushing = flushNoteOutbox(db, async (operation) => {
			requestStarted();
			await requestBlocked;
			return {
				id: operation.noteId,
				title: operation.title,
				path: operation.path,
				isPublic: false,
			};
		});
		await started;
		await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'Latest', path: null },
			102,
		);
		releaseRequest();
		await flushing;

		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Latest',
			path: null,
			dirty: false,
			serverUpdatedAt: 10,
		});
		expect(await db.outbox.toArray()).toEqual([
			expect.objectContaining({
				type: 'metadata',
				createdAt: 102,
				title: 'Latest',
			}),
		]);
	});

	it('keeps newer pending metadata when an older content save confirms', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Latest title',
			path: 'latest',
			isPublic: false,
			createdAt: 1,
			updatedAt: 100,
			serverUpdatedAt: 1,
			content: content('Local content'),
			dirty: false,
		});
		await db.outbox.bulkPut([
			{
				key: 'note-1:100',
				type: 'save',
				noteId: 'note-1',
				title: 'Old title',
				path: 'old',
				createdAt: 100,
				content: content('Local content'),
			},
			{
				key: 'metadata:note-1',
				type: 'metadata',
				noteId: 'note-1',
				title: 'Latest title',
				path: 'latest',
				isPublic: false,
				createdAt: 101,
			},
		]);

		await flushNoteOutbox(db, async (operation) =>
			operation.type === 'save'
				? {
						id: 'note-1',
						title: 'Old title',
						path: 'old',
						isPublic: false,
						createdAt: 1,
						updatedAt: 100,
						content: operation.content,
					}
				: {
						id: 'note-1',
						title: operation.title,
						path: operation.path,
						isPublic: false,
					},
		);

		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Latest title',
			path: 'latest',
			serverUpdatedAt: 100,
		});
	});

	it('serializes concurrent syncs and drains metadata added in flight', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Saved',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			serverUpdatedAt: 1,
			dirty: false,
		});
		await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'First', path: null },
			100,
		);
		let release: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => undefined;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const sent: string[] = [];
		const synchronize = createNoteOutboxSynchronizer(db, async (operation) => {
			sent.push(operation.title);
			if (sent.length === 1) {
				started();
				await blocked;
			}
			return {
				id: operation.noteId,
				title: operation.title,
				path: operation.path,
				isPublic: false,
			};
		});

		const firstSync = synchronize();
		await requestStarted;
		await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'Latest', path: 'work' },
			101,
		);
		const concurrentSync = synchronize();
		release();
		await Promise.all([firstSync, concurrentSync]);

		expect(sent).toEqual(['First', 'Latest']);
		expect(await db.outbox.count()).toBe(0);
	});

	it('queues idempotent saves with monotonic timestamps', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Draft',
			path: 'work',
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			serverUpdatedAt: 1,
			content: content('First'),
			dirty: true,
		});

		const first = await enqueueNoteSave(db, 'note-1', 100);
		await updateNoteContentDraft(db, 'note-1', content('Second'));
		const second = await enqueueNoteSave(db, 'note-1', 100);

		expect(first.createdAt).toBe(100);
		expect(second.createdAt).toBe(101);
		expect(
			(await db.outbox.orderBy('createdAt').toArray()).map((item) => item.key),
		).toEqual(['note-1:100', 'note-1:101']);
		expect(await db.notes.get('note-1')).toMatchObject({
			dirty: false,
			updatedAt: 101,
			serverUpdatedAt: 1,
			draftUpdatedAt: undefined,
		});
	});

	it('flushes saves in order and leaves failed work queued', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Draft',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			content: content('First'),
			dirty: true,
		});
		await enqueueNoteSave(db, 'note-1', 100);
		await updateNoteContentDraft(db, 'note-1', content('Second'));
		await enqueueNoteSave(db, 'note-1', 101);
		const sent: number[] = [];

		const result = await flushNoteOutbox(db, async (operation) => {
			if (operation.type !== 'save') throw new Error('Unexpected metadata');
			sent.push(operation.createdAt);
			if (operation.createdAt === 101) throw new Error('offline');
			return {
				id: operation.noteId,
				title: operation.title,
				path: operation.path,
				isPublic: false,
				createdAt: 1,
				updatedAt: operation.createdAt,
				content: operation.content,
			};
		});

		expect(sent).toEqual([100, 101]);
		expect(result.failed?.operation.createdAt).toBe(101);
		expect((await db.outbox.toArray()).map((item) => item.createdAt)).toEqual([
			101,
		]);
		expect(await db.notes.get('note-1')).toMatchObject({ updatedAt: 101 });
	});

	it('reconciles server summaries without overwriting pending local work', async () => {
		await db.notes.bulkPut([
			{
				id: 'pending',
				title: 'Local title',
				path: null,
				isPublic: false,
				createdAt: 1,
				updatedAt: 20,
				content: content('Pending'),
				dirty: false,
			},
			{
				id: 'stale',
				title: 'Removed remotely',
				path: null,
				isPublic: false,
				createdAt: 1,
				updatedAt: 1,
				dirty: false,
			},
		]);
		await db.outbox.put({
			key: 'pending:20',
			type: 'save',
			noteId: 'pending',
			title: 'Local title',
			path: null,
			createdAt: 20,
			content: content('Pending'),
		});

		await reconcileNoteSummaries(db, [
			{
				id: 'pending',
				title: 'Server title',
				path: 'server',
				isPublic: false,
				createdAt: 1,
				updatedAt: 10,
			},
		]);

		expect(await db.notes.get('pending')).toMatchObject({
			title: 'Local title',
			path: null,
			updatedAt: 20,
		});
		expect(await db.notes.get('stale')).toBeUndefined();
	});

	it('resolves LWW between local drafts and remote snapshots', async () => {
		const draft = content('New local draft');
		await db.notes.put({
			id: 'note-1',
			title: 'Local',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 100,
			content: content('Saved'),
			dirty: false,
		});
		await updateNoteContentDraft(db, 'note-1', draft, 300);

		await cacheRemoteNote(db, {
			id: 'note-1',
			title: 'Remote',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 200,
			content: content('Remote'),
		});

		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Local',
			content: draft,
			dirty: true,
			draftUpdatedAt: 300,
		});

		await db.notes.clear();
		await db.notes.put({
			id: 'note-1',
			title: 'Saved',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 50,
			content: content('Saved'),
			dirty: false,
		});
		await updateNoteContentDraft(db, 'note-1', content('Old local'), 100);

		const remoteContent = content('New remote');
		await cacheRemoteNote(db, {
			id: 'note-1',
			title: 'Remote',
			path: 'remote',
			isPublic: false,
			createdAt: 1,
			updatedAt: 200,
			content: remoteContent,
		});

		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Remote',
			path: 'remote',
			content: remoteContent,
			dirty: false,
			draftUpdatedAt: undefined,
		});
	});

	it('records a newer server summary so a stale dirty note can fetch it', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Local',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 50,
			draftUpdatedAt: 100,
			content: content('Local'),
			dirty: true,
		});

		await reconcileNoteSummaries(db, [
			{
				id: 'note-1',
				title: 'Remote',
				path: 'remote',
				isPublic: false,
				createdAt: 1,
				updatedAt: 200,
			},
		]);

		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Local',
			updatedAt: 200,
			draftUpdatedAt: 100,
			dirty: true,
		});
	});

	it('outranks the last confirmed server version when queueing a save', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Draft',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 5_000,
			content: content('Local'),
			dirty: true,
		});

		const operation = await enqueueNoteSave(db, 'note-1', 100);

		expect(operation.createdAt).toBe(5_001);
	});

	it('drops cached content once the server reports a newer version', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Note',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 10,
			content: content('Stale'),
			dirty: false,
		});

		await reconcileNoteSummaries(db, [
			{
				id: 'note-1',
				title: 'Note',
				path: null,
				isPublic: false,
				createdAt: 1,
				updatedAt: 20,
			},
		]);

		expect(await db.notes.get('note-1')).toMatchObject({
			content: undefined,
			updatedAt: 20,
			serverUpdatedAt: 20,
		});
	});

	it('carries the fields a metadata change does not mention', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Shared',
			path: 'study',
			isPublic: true,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 10,
			dirty: false,
		});

		const renamed = await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'Renamed' },
			100,
		);

		// Renaming a note must not unpublish it, and publishing one must not move it.
		expect(renamed).toMatchObject({
			title: 'Renamed',
			path: 'study',
			isPublic: true,
		});
		expect(await db.notes.get('note-1')).toMatchObject({
			title: 'Renamed',
			path: 'study',
			isPublic: true,
		});

		const published = await enqueueNoteMetadata(
			db,
			'note-1',
			{ isPublic: false },
			101,
		);

		expect(published).toMatchObject({
			title: 'Renamed',
			path: 'study',
			isPublic: false,
		});
	});

	it('treats a note cached before publishing existed as private', async () => {
		// Written by a build that had no such column, so the row genuinely lacks
		// the field rather than storing `false`.
		await db.notes.put({
			id: 'note-1',
			title: 'Old cache',
			path: null,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 10,
			dirty: false,
		} as LocalNote);

		const renamed = await enqueueNoteMetadata(
			db,
			'note-1',
			{ title: 'Renamed' },
			100,
		);

		// Sending `undefined` here would cost a 422 on the first rename of every
		// note that predates the column.
		expect(renamed?.isPublic).toBe(false);
	});

	it('keeps a queued publication when a remote snapshot arrives first', async () => {
		await db.notes.put({
			id: 'note-1',
			title: 'Shared',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 10,
			serverUpdatedAt: 10,
			dirty: false,
		});
		await enqueueNoteMetadata(db, 'note-1', { isPublic: true }, 100);

		await cacheRemoteNote(db, {
			id: 'note-1',
			title: 'Shared',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 20,
			content: content('Remote'),
		});

		expect(await db.notes.get('note-1')).toMatchObject({ isPublic: true });
	});

	it('drops terminally rejected work instead of stalling the queue behind it', async () => {
		for (const id of ['rejected', 'later']) {
			await db.notes.put({
				id,
				title: id,
				path: null,
				isPublic: false,
				createdAt: 1,
				updatedAt: 1,
				content: content(id),
				dirty: true,
			});
		}
		await enqueueNoteSave(db, 'rejected', 100);
		await enqueueNoteSave(db, 'later', 200);

		const synchronize = createNoteOutboxSynchronizer(db, async (operation) => {
			if (operation.noteId === 'rejected')
				throw Object.assign(new Error('Title already taken'), {
					terminal: true,
				});
			if (operation.type !== 'save') throw new Error('Unexpected metadata');
			return {
				id: operation.noteId,
				title: operation.title,
				path: operation.path,
				isPublic: false,
				createdAt: 1,
				updatedAt: operation.createdAt,
				content: operation.content,
			};
		});
		const discarded = await synchronize();

		expect(discarded.map(({ operation }) => operation.noteId)).toEqual([
			'rejected',
		]);
		expect(await db.outbox.count()).toBe(0);
		expect(await db.notes.get('rejected')).toMatchObject({
			syncFailure: 'Title already taken',
		});
		expect(await db.notes.get('later')).toMatchObject({ updatedAt: 200 });
		expect((await db.notes.get('later'))?.syncFailure).toBeUndefined();
	});
});
