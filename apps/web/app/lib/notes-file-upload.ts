import { NOTES_UPLOAD_FOLDER, pastedImageName } from '@web/lib/notes-files';
import type { StoredFile } from '@web/lib/storage-api';
import { uploadStoredFiles } from '@web/lib/storage-file-upload';
import type { UploadItem } from '@web/lib/storage-upload';

/** Notes' shape of the shared upload: its folder, flagged as its own. */
export async function uploadNoteFiles(
	selected: File[],
	onProgress?: (items: UploadItem[]) => void,
): Promise<StoredFile[]> {
	return uploadStoredFiles(
		selected,
		{ folder: NOTES_UPLOAD_FOLDER, uploadedFromNotes: true },
		onProgress,
	);
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
