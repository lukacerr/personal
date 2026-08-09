import type { StoredFile } from '@web/lib/storage-api';
import {
	BulkDownloadError,
	createStorageBulkDownload,
	relativeArchivePath,
} from '@web/lib/storage-bulk-download';
import { describe, expect, it, vi } from 'vitest';

function file(id: string, name: string, path: string | null, size = 4) {
	return {
		id,
		name,
		path,
		contentType: 'text/plain',
		size,
		isPublic: false,
		createdAt: 0,
		updatedAt: 0,
	} as StoredFile;
}

describe('Storage bulk download', () => {
	it('preserves paths relative to the open folder', () => {
		expect(relativeArchivePath(file('a', 'one.txt', 'work'), 'work')).toBe(
			'one.txt',
		);
		expect(
			relativeArchivePath(file('b', 'one.txt', 'work/archive'), 'work'),
		).toBe('archive/one.txt');
		expect(relativeArchivePath(file('c', 'root.txt', null), null)).toBe(
			'root.txt',
		);
	});

	it('feeds every signed response into one archive and reports bytes', async () => {
		const saved: Blob[] = [];
		const progress: number[] = [];
		const files = [
			file('a', 'one.txt', 'work'),
			file('b', 'two.txt', 'work/deep'),
		];
		const download = createStorageBulkDownload({
			getLinks: async () =>
				files.map((entry) => ({
					...entry,
					url: `https://files.test/${entry.id}`,
					expiresAt: Date.now() + 1000,
				})),
			fetch: async (url) =>
				new Response(String(url).endsWith('/a') ? 'aaaa' : 'bbbb'),
			zip: async (entries) => {
				const contents: string[] = [];
				for await (const entry of entries)
					contents.push(`${entry.name}:${await entry.input.text()}`);
				return new Blob([contents.join('|')]);
			},
			saveBlob: (blob) => saved.push(blob),
		});

		await download(files, 'work', (value) => progress.push(value));

		expect(await saved[0]?.text()).toBe('one.txt:aaaa|deep/two.txt:bbbb');
		expect(progress.at(-1)).toBe(1);
		expect([...progress].sort((a, b) => a - b)).toEqual(progress);
	});

	it('rejects a large Blob fallback before requesting links', async () => {
		const getLinks = vi.fn();
		const download = createStorageBulkDownload({
			getLinks,
			fetch,
			zip: async () => new Blob(),
			saveBlob: vi.fn(),
			maxBlobBytes: 100,
		});

		await expect(
			download([file('a', 'large.bin', null, 101)], null),
		).rejects.toEqual(new BulkDownloadError('TOO_LARGE'));
		expect(getLinks).not.toHaveBeenCalled();
	});

	/**
	 * Dismissing the native save dialog is an answer. Reporting it as "the ZIP
	 * could not be downloaded" tells the user something went wrong when nothing
	 * did, and invites them to retry the thing they just declined.
	 */
	it('treats a dismissed save dialog as a cancellation', async () => {
		const saveBlob = vi.fn();
		const download = createStorageBulkDownload({
			getLinks: async () => [],
			fetch,
			zip: async () => new Blob(),
			zipStream: async () => new ReadableStream<Uint8Array>(),
			pickFile: async () => {
				throw new BulkDownloadError('CANCELLED');
			},
			saveBlob,
		});

		await expect(download([file('a', 'one.txt', null)], null)).rejects.toEqual(
			new BulkDownloadError('CANCELLED'),
		);
		expect(saveBlob).not.toHaveBeenCalled();
	});

	it('aborts without saving a partial archive when one fetch fails', async () => {
		const saveBlob = vi.fn();
		const files = [file('a', 'one.txt', null), file('b', 'two.txt', null)];
		const download = createStorageBulkDownload({
			getLinks: async () =>
				files.map((entry) => ({ ...entry, url: entry.id, expiresAt: 1 })),
			fetch: async (url) =>
				String(url) === 'a'
					? new Response('ok')
					: new Response('', { status: 500 }),
			zip: async (entries) => {
				for await (const entry of entries) await entry.input.arrayBuffer();
				return new Blob(['partial']);
			},
			saveBlob,
		});

		await expect(download(files, null)).rejects.toBeInstanceOf(
			BulkDownloadError,
		);
		expect(saveBlob).not.toHaveBeenCalled();
	});
});
