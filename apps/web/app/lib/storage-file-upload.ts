import { uniqueFileName } from '@web/lib/storage';
import { type StoredFile, storageTransport } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { createUploadQueue, type UploadItem } from '@web/lib/storage-upload';

/**
 * Uploads into a folder and answers with what the server stored. Shared by
 * Notes (folder `Notes/`, flagged) and the Agent composer (folder `Agent/`).
 *
 * The index is refreshed first because the names it holds decide the suffix:
 * a stale copy would let a name through that the server then rejects, and a
 * rejection in the middle of typing is the dead end this avoids.
 */
export async function uploadStoredFiles(
	selected: File[],
	options: { folder: string; uploadedFromNotes?: boolean },
	onProgress?: (items: UploadItem[]) => void,
): Promise<StoredFile[]> {
	if (selected.length === 0) return [];
	await useStorageStore.getState().load(true);

	const claimed = useStorageStore
		.getState()
		.files.map(({ id, name, path }) => ({ id, name, path }));
	const candidates = selected.map((item) => {
		const name = uniqueFileName(claimed, options.folder, item.name);
		const id = crypto.randomUUID();
		// Two files pasted at once must not both claim the same free name.
		claimed.push({ id, name, path: options.folder });
		return {
			id,
			name,
			path: options.folder,
			contentType: item.type || 'application/octet-stream',
			size: item.size,
			uploadedFromNotes: options.uploadedFromNotes ?? false,
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
