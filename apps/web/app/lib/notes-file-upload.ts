import { NOTES_UPLOAD_FOLDER, pastedImageName } from '@web/lib/notes-files';
import { uniqueFileName } from '@web/lib/storage';
import { type StoredFile, storageTransport } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { createUploadQueue, type UploadItem } from '@web/lib/storage-upload';

/**
 * Uploads into the Notes folder and answers with what the server stored.
 *
 * The index is refreshed first because the names it holds decide the suffix:
 * a stale copy would let a name through that the server then rejects, and a
 * rejection in the middle of typing is the dead end this avoids.
 */
export async function uploadNoteFiles(
	selected: File[],
	onProgress?: (items: UploadItem[]) => void,
): Promise<StoredFile[]> {
	if (selected.length === 0) return [];
	await useStorageStore.getState().load(true);

	const claimed = useStorageStore
		.getState()
		.files.map(({ id, name, path }) => ({ id, name, path }));
	const candidates = selected.map((item) => {
		const name = uniqueFileName(claimed, NOTES_UPLOAD_FOLDER, item.name);
		const id = crypto.randomUUID();
		// Two files pasted at once must not both claim the same free name.
		claimed.push({ id, name, path: NOTES_UPLOAD_FOLDER });
		return {
			id,
			name,
			path: NOTES_UPLOAD_FOLDER,
			contentType: item.type || 'application/octet-stream',
			size: item.size,
			uploadedFromNotes: true,
			body: item,
		};
	});

	const queue = createUploadQueue({
		transport: storageTransport,
		onChange: onProgress,
	});
	await queue.enqueue(candidates);

	const stored = new Set(
		queue
			.items()
			.filter((item) => item.status === 'completed')
			.map((item) => item.id),
	);
	if (stored.size === 0) return [];

	// The rows come back from the server rather than from the candidates: the
	// size and the name are whatever storage actually recorded.
	await useStorageStore.getState().load(true);
	return useStorageStore.getState().files.filter((file) => stored.has(file.id));
}

/**
 * Fetches images that were pasted as URLs so they can be stored like any other
 * attachment.
 *
 * A cross-origin image the browser refuses to read comes back as a failure
 * rather than as a link left in the document: a note pointing at somebody
 * else's server is exactly what this avoids, and saying so is better than
 * quietly doing it.
 */
export async function downloadPastedImages(sources: string[]) {
	const files: File[] = [];
	const failed: string[] = [];

	for (const source of sources) {
		try {
			const response = await fetch(source);
			if (!response.ok) throw new Error('Unreachable');
			const blob = await response.blob();
			if (!blob.type.startsWith('image/')) throw new Error('Not an image');
			files.push(
				new File([blob], pastedImageName(source, blob.type), {
					type: blob.type,
				}),
			);
		} catch {
			failed.push(source);
		}
	}

	return { files, failed };
}

/**
 * The images the clipboard holds, read through the asynchronous API.
 *
 * WebKitGTK — the engine behind the desktop shell on Linux — hands the `paste`
 * event a completely empty `clipboardData` when the clipboard holds an image,
 * while `navigator.clipboard.read()` returns it. Verified against that engine
 * directly: the synchronous event reports no types, no files and no items for
 * the same clipboard the async read answers with a PNG.
 *
 * Only reached when the event carried nothing at all, so a plain-text paste
 * never asks for clipboard permission on engines where the event works.
 */
export async function readClipboardImages(): Promise<File[]> {
	// Undefined in an insecure context, which a LAN client over plain HTTP is.
	if (!navigator.clipboard?.read) return [];

	try {
		const items = await navigator.clipboard.read();
		const files: File[] = [];
		for (const item of items) {
			const type = item.types.find((entry) => entry.startsWith('image/'));
			if (!type) continue;
			const blob = await item.getType(type);
			files.push(
				new File([blob], `pasted-image.${type.split('/')[1] ?? 'png'}`, {
					type,
				}),
			);
		}
		return files;
	} catch {
		// A refused permission or a clipboard holding nothing readable.
		return [];
	}
}
