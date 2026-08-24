import { authenticatedApi } from '@web/lib/authenticated-api';
import { env } from '@web/lib/env';
import { conditionalGet } from '@web/lib/http-conditional';
import type {
	PutOptions,
	UploadedPart,
	UploadRequest,
	UploadTransport,
} from '@web/lib/storage-upload';
import type { TreatyData } from '@web/lib/treaty-data';

type StoredFiles = Extract<
	TreatyData<typeof authenticatedApi.files.get>,
	unknown[]
>;

/** The contract itself, never a hand-written copy of it. */
export type StoredFile = StoredFiles[number];

/**
 * The one URL for a file that never expires and needs no session. It only
 * answers for a published file; everything else gets the same 404 a file that
 * never existed would.
 */
export function publicFileUrl(id: string) {
	return `${env.VITE_API_URL.replace(/\/$/, '')}/public/files/${id}`;
}

export class StorageApiError extends Error {
	constructor(readonly status: number) {
		super(`Storage API returned ${status}`);
	}
}

/**
 * The index, or word that the copy already held is still current.
 *
 * Every upload, move, rename and delete refreshes this list, so answering the
 * repeat with a 304 is the common path rather than an optimisation for a rare
 * one.
 */
export function listFiles(
	knownTag?: string,
): Promise<{ files: StoredFile[]; tag?: string } | 'unchanged'> {
	return conditionalGet(
		knownTag,
		(conditional) => authenticatedApi.files.get(conditional),
		(response) => {
			if (response.status !== 200 || !Array.isArray(response.data))
				throw new StorageApiError(response.status);
			return { files: response.data };
		},
	);
}

/** Notes uploads no note references anymore; only the server can tell. */
export async function listUnreferencedFiles(): Promise<StoredFile[]> {
	const response = await authenticatedApi.files.unreferenced.get();
	if (response.status !== 200 || !Array.isArray(response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

export async function getFile(id: string): Promise<StoredFile> {
	const response = await authenticatedApi.files({ id }).get();
	if (response.status !== 200 || !response.data || !('name' in response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

export async function getFileLink(
	id: string,
	disposition: 'inline' | 'attachment' = 'inline',
) {
	const response = await authenticatedApi
		.files({ id })
		.link.get({ query: { disposition } });

	if (response.status !== 200 || !response.data || !('url' in response.data))
		throw new StorageApiError(response.status);
	return response.data.url;
}

export async function updateFile(
	id: string,
	metadata: { name: string; path: string | null; isPublic: boolean },
) {
	const response = await authenticatedApi.files({ id }).patch(metadata);
	if (response.status !== 200 || !response.data || !('name' in response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

export async function deleteFile(id: string) {
	const response = await authenticatedApi.files({ id }).delete();
	if (response.status !== 204) throw new StorageApiError(response.status);
}

export async function moveFiles(ids: string[], path: string | null) {
	const response = await authenticatedApi.files.bulk.move.patch({ ids, path });
	if (response.status !== 200 || !Array.isArray(response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

export async function deleteFiles(ids: string[]) {
	const response = await authenticatedApi.files.bulk.delete.post({ ids });
	if (
		response.status !== 200 ||
		!response.data ||
		!('deleted' in response.data) ||
		!('failed' in response.data)
	)
		throw new StorageApiError(response.status);
	return response.data;
}

export async function getFileLinks(ids: string[]) {
	const response = await authenticatedApi.files.bulk.links.post({ ids });
	if (response.status !== 200 || !Array.isArray(response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

export async function renameFolder(from: string, to: string) {
	const response = await authenticatedApi.files.folders.patch({ from, to });
	if (
		response.status !== 200 ||
		!response.data ||
		!('updated' in response.data)
	)
		throw new StorageApiError(response.status);
	return response.data;
}

export async function deleteFolder(path: string) {
	const response = await authenticatedApi.files.folders.delete({ path });
	if (
		response.status !== 200 ||
		!response.data ||
		!('deleted' in response.data)
	)
		throw new StorageApiError(response.status);
	return response.data;
}

export async function reconcileStorage() {
	const response = await authenticatedApi.files.reconcile.post();
	if (response.status !== 200 || !response.data)
		throw new StorageApiError(response.status);
	if (!('deletedObjects' in response.data))
		throw new StorageApiError(response.status);
	return response.data;
}

/**
 * Uploads bytes with `XMLHttpRequest` rather than `fetch`: it is the only way
 * to get upload progress without experimental streams, and its `abort()` is
 * what makes cancelling a transfer real rather than cosmetic.
 */
function putWithProgress(url: string, body: Blob, options: PutOptions) {
	return new Promise<{ etag: string | null }>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('PUT', url);
		if (options.contentType)
			request.setRequestHeader('content-type', options.contentType);

		request.upload.addEventListener('progress', (event) => {
			if (event.lengthComputable)
				options.onProgress?.(event.loaded / event.total);
		});
		request.addEventListener('load', () => {
			if (request.status < 200 || request.status >= 300) {
				reject(new StorageApiError(request.status));
				return;
			}
			options.onProgress?.(1);
			// Requires `ExposeHeaders: [etag]` in the bucket's CORS rules, or the
			// browser hides it and a multipart upload can never be completed.
			resolve({ etag: request.getResponseHeader('etag') });
		});
		request.addEventListener('error', () =>
			reject(new Error('The connection dropped during the upload.')),
		);
		request.addEventListener('abort', () =>
			reject(new Error('The upload was cancelled.')),
		);

		options.signal?.addEventListener('abort', () => request.abort(), {
			once: true,
		});
		request.send(body);
	});
}

export const storageTransport: UploadTransport = {
	async reserve(requests: UploadRequest[]) {
		const response = await authenticatedApi.files.uploads.post({
			// The explorer leaves the flag off; the contract still wants it said.
			files: requests.map((request) => ({
				...request,
				uploadedFromNotes: request.uploadedFromNotes ?? false,
			})),
		});
		if (
			response.status !== 200 ||
			!response.data ||
			!('results' in response.data)
		)
			throw new StorageApiError(response.status);
		return response.data.results as never;
	},

	async signParts(id, partNumbers) {
		const response = await authenticatedApi
			.files({ id })
			.parts.post({ partNumbers });
		if (
			response.status !== 200 ||
			!response.data ||
			!('parts' in response.data)
		)
			throw new StorageApiError(response.status);
		return response.data.parts;
	},

	put: putWithProgress,

	async complete(id, parts: UploadedPart[]) {
		const response = await authenticatedApi
			.files({ id })
			.complete.post({ parts });
		if (response.status !== 201 || !response.data || !('name' in response.data))
			throw new StorageApiError(response.status);
		return response.data;
	},

	async cancel(id) {
		await authenticatedApi.files({ id }).delete();
	},
};
