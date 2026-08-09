import { getFileLinks, type StoredFile } from '@web/lib/storage-api';

export const MAX_BLOB_ZIP_BYTES = 100 * 1024 * 1024;

export class BulkDownloadError extends Error {
	constructor(readonly code: 'TOO_LARGE' | 'DOWNLOAD_FAILED' | 'CANCELLED') {
		super(code);
	}
}

type ManifestEntry = StoredFile & {
	url: string;
	expiresAt: number;
};

type ArchiveEntry = {
	name: string;
	input: Response;
	lastModified: Date;
};

type WritableFileHandle = {
	createWritable(): Promise<WritableStream<Uint8Array>>;
};

type BulkDownloadDependencies = {
	getLinks: (ids: string[]) => Promise<ManifestEntry[]>;
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	zip: (entries: AsyncIterable<ArchiveEntry>) => Promise<Blob>;
	zipStream?: (
		entries: AsyncIterable<ArchiveEntry>,
	) => Promise<ReadableStream<Uint8Array>>;
	pickFile?: (name: string) => Promise<WritableFileHandle>;
	saveBlob: (blob: Blob, name: string) => void;
	maxBlobBytes?: number;
};

export function relativeArchivePath(file: StoredFile, root: string | null) {
	if (!file.path || file.path === root) return file.name;
	const relative =
		root && file.path.startsWith(`${root}/`)
			? file.path.slice(root.length + 1)
			: file.path;
	return `${relative}/${file.name}`;
}

export function createStorageBulkDownload({
	getLinks,
	fetch: fetchFile,
	zip,
	zipStream,
	pickFile,
	saveBlob,
	maxBlobBytes = MAX_BLOB_ZIP_BYTES,
}: BulkDownloadDependencies) {
	return async (
		files: StoredFile[],
		root: string | null,
		onProgress: (progress: number) => void = () => undefined,
		signal?: AbortSignal,
	) => {
		const total = files.reduce((sum, file) => sum + file.size, 0);
		if (!pickFile && total > maxBlobBytes)
			throw new BulkDownloadError('TOO_LARGE');

		const archiveName = `storage-${new Date().toISOString().slice(0, 10)}.zip`;
		// The picker must start during the click activation. Network awaits come after.
		const handlePromise = pickFile?.(archiveName);
		const manifest = await getLinks(files.map((file) => file.id));
		let loaded = 0;
		onProgress(0);

		async function* entries(): AsyncGenerator<ArchiveEntry> {
			for (const entry of manifest) {
				if (signal?.aborted) throw new BulkDownloadError('CANCELLED');
				const response = await fetchFile(entry.url, { signal });
				if (!response.ok || !response.body)
					throw new BulkDownloadError('DOWNLOAD_FAILED');

				const tracked = response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							loaded += chunk.byteLength;
							onProgress(Math.min(0.99, loaded / Math.max(total, 1)));
							controller.enqueue(chunk);
						},
					}),
				);
				yield {
					name: relativeArchivePath(entry, root),
					input: new Response(tracked, {
						headers: { 'content-type': entry.contentType },
					}),
					lastModified: new Date(entry.updatedAt),
				};
			}
		}

		try {
			if (handlePromise && zipStream) {
				const [handle, stream] = await Promise.all([
					handlePromise,
					zipStream(entries()),
				]);
				await stream.pipeTo(await handle.createWritable(), { signal });
			} else {
				const blob = await zip(entries());
				saveBlob(blob, archiveName);
			}
			onProgress(1);
		} catch (error) {
			if (signal?.aborted) throw new BulkDownloadError('CANCELLED');
			if (error instanceof BulkDownloadError) throw error;
			if (error instanceof DOMException && error.name === 'AbortError')
				throw new BulkDownloadError('CANCELLED');
			throw new BulkDownloadError('DOWNLOAD_FAILED');
		}
	};
}

function saveBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	queueMicrotask(() => URL.revokeObjectURL(url));
}

type FilePickerWindow = Window &
	typeof globalThis & {
		showSaveFilePicker?: (options: {
			suggestedName: string;
			types: Array<{
				description: string;
				accept: Record<string, string[]>;
			}>;
		}) => Promise<WritableFileHandle>;
	};

export async function downloadStorageZip(
	files: StoredFile[],
	root: string | null,
	onProgress?: (progress: number) => void,
	signal?: AbortSignal,
) {
	const picker = (window as FilePickerWindow).showSaveFilePicker;
	const archiveName = `storage-${new Date().toISOString().slice(0, 10)}.zip`;
	// Start the native picker before the first await or browsers reject it for
	// lacking a direct user activation.
	const handleResultPromise = picker?.({
		suggestedName: archiveName,
		types: [
			{
				description: 'ZIP archive',
				accept: { 'application/zip': ['.zip'] },
			},
		],
	}).then(
		(handle) => ({ handle }),
		(error: unknown) => ({ error }),
	);
	const { downloadZip, makeZip } = await import('client-zip');
	const download = createStorageBulkDownload({
		getLinks: async (ids) => getFileLinks(ids),
		fetch,
		zip: async (entries) => (await downloadZip(entries)).blob(),
		zipStream: async (entries) => makeZip(entries),
		pickFile: handleResultPromise
			? async () => {
					const result = await handleResultPromise;
					// Dismissing the save dialog is an answer, not a failure: the
					// browser reports it as an AbortError and it means "not now".
					if ('error' in result) {
						if (
							result.error instanceof DOMException &&
							result.error.name === 'AbortError'
						)
							throw new BulkDownloadError('CANCELLED');
						throw result.error;
					}
					return result.handle;
				}
			: undefined,
		saveBlob,
	});
	return download(files, root, onProgress, signal);
}
