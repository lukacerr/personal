import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
	load: vi.fn(async () => {
		// The second load is what surfaces the stored rows to the caller.
		if (enqueued.length > 0)
			state.files = enqueued.map((candidate) => ({
				id: candidate.id as string,
				name: candidate.name as string,
				path: candidate.path as string,
			}));
	}),
	files: [] as Array<{ id: string; name: string; path: string | null }>,
};

vi.mock('@web/lib/storage-store', () => ({
	useStorageStore: { getState: () => state },
}));

const enqueued: Array<Record<string, unknown>> = [];
let failAll = false;

vi.mock('@web/lib/storage-upload', () => ({
	createUploadQueue: () => ({
		enqueue: async (candidates: Array<Record<string, unknown>>) => {
			enqueued.push(...candidates);
		},
		items: () =>
			enqueued.map((candidate) => ({
				id: candidate.id,
				status: failAll ? 'failed' : 'completed',
			})),
	}),
}));

vi.mock('@web/lib/storage-api', () => ({ storageTransport: {} }));

import { uploadStoredFiles } from '@web/lib/storage-file-upload';

beforeEach(() => {
	enqueued.length = 0;
	failAll = false;
	state.files = [];
	state.load.mockClear();
});

describe('uploadStoredFiles', () => {
	it('uploads into the given folder and returns the stored rows', async () => {
		const selected = [new File(['x'], 'photo.png', { type: 'image/png' })];

		const stored = await uploadStoredFiles(selected, { folder: 'Agent' });

		expect(enqueued[0]).toMatchObject({
			name: 'photo.png',
			path: 'Agent',
			contentType: 'image/png',
			uploadedFromNotes: false,
		});
		expect(stored.map((file) => file.name)).toEqual(['photo.png']);
	});

	it('dedupes names against the refreshed index', async () => {
		state.files = [{ id: 'a', name: 'photo.png', path: 'Agent' }];
		const selected = [new File(['x'], 'photo.png', { type: 'image/png' })];

		await uploadStoredFiles(selected, { folder: 'Agent' });

		expect(enqueued[0]?.name).toBeDefined();
		expect(enqueued[0]?.name).not.toBe('photo.png');
	});

	it('flags notes uploads when asked to', async () => {
		const selected = [new File(['x'], 'doc.txt', { type: 'text/plain' })];

		await uploadStoredFiles(selected, {
			folder: 'Notes',
			uploadedFromNotes: true,
		});

		expect(enqueued[0]).toMatchObject({
			path: 'Notes',
			uploadedFromNotes: true,
		});
	});

	it('returns nothing when every upload failed', async () => {
		failAll = true;
		const selected = [new File(['x'], 'doc.txt', { type: 'text/plain' })];

		const stored = await uploadStoredFiles(selected, { folder: 'Agent' });

		expect(stored).toEqual([]);
	});
});
