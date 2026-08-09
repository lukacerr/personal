import { env } from '@api/env';
import {
	multipartUploadId,
	objectKey,
	type PendingUpload,
	type PendingUploadMarker,
	parsePendingUploads,
	verifyCompletedUpload,
} from '@api/files-storage';
import { AwsClient } from 'aws4fetch';

/**
 * Multipart uploads, which `Bun.S3Client` does not expose.
 *
 * Its `presign` signs a single operation on a key, but an upload part is
 * `PUT /files/<id>?partNumber=3&uploadId=<x>`, and those query parameters are
 * part of the SigV4 canonical request: they cannot be appended to an already
 * signed URL. `writer()` does multipart internally, but from the server, which
 * is exactly the round trip presigned uploads exist to avoid.
 */
const client = new AwsClient({
	accessKeyId: env.S3_ACCESS_KEY_ID,
	secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	service: 's3',
	region: env.S3_REGION,
});

function endpoint(base: string, id: string) {
	return `${base.replace(/\/$/, '')}/${env.S3_BUCKET}/${objectKey(id)}`;
}

/** Where the API itself talks to storage. */
function internalUrl(id: string) {
	return endpoint(env.S3_ENDPOINT, id);
}

/** Where the browser talks to storage, which inside Compose is a different host. */
function publicUrl(id: string) {
	return endpoint(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT, id);
}

export async function createMultipartUpload(id: string, contentType: string) {
	const response = await client.fetch(`${internalUrl(id)}?uploads=`, {
		method: 'POST',
		headers: { 'content-type': contentType },
	});
	const uploadId = multipartUploadId(await response.text());

	if (!response.ok || !uploadId)
		throw new Error(`Could not start a multipart upload for ${id}`);
	return uploadId;
}

/**
 * Signs a batch of part URLs. They are requested in batches rather than all at
 * once because a 5 TiB upload has ten thousand parts, and because each batch
 * hands back fresh signatures to an upload that may run for hours.
 */
export async function presignParts(
	id: string,
	uploadId: string,
	partNumbers: number[],
	expiresIn: number,
) {
	return Promise.all(
		partNumbers.map(async (partNumber) => {
			const url = new URL(publicUrl(id));
			url.searchParams.set('partNumber', String(partNumber));
			url.searchParams.set('uploadId', uploadId);
			url.searchParams.set('X-Amz-Expires', String(expiresIn));
			const signed = await client.sign(
				new Request(url.toString(), { method: 'PUT' }),
				{ aws: { signQuery: true } },
			);
			return { partNumber, url: signed.url };
		}),
	);
}

export type UploadedPart = { partNumber: number; etag: string };

export async function completeMultipartUpload(
	id: string,
	uploadId: string,
	parts: UploadedPart[],
) {
	const body = `<CompleteMultipartUpload>${[...parts]
		.sort((a, b) => a.partNumber - b.partNumber)
		.map(
			({ partNumber, etag }) =>
				`<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
		)
		.join('')}</CompleteMultipartUpload>`;

	const response = await client.fetch(
		`${internalUrl(id)}?uploadId=${encodeURIComponent(uploadId)}`,
		{ method: 'POST', body, headers: { 'content-type': 'application/xml' } },
	);

	return verifyCompletedUpload(response.status, await response.text());
}

/**
 * Abandoned parts keep costing storage and never show up in a bucket listing,
 * so an upload that will not finish has to be told so explicitly.
 */
export async function abortMultipartUpload(id: string, uploadId: string) {
	await client
		.fetch(`${internalUrl(id)}?uploadId=${encodeURIComponent(uploadId)}`, {
			method: 'DELETE',
		})
		.catch(() => undefined);
}

/**
 * The only way to see multipart uploads: they are invisible to `ListObjects`.
 * Paged to the end, because an abandoned upload the listing never reached keeps
 * costing storage with nothing left that can find it.
 */
export async function listPendingUploads(): Promise<PendingUpload[]> {
	const base = `${env.S3_ENDPOINT.replace(/\/$/, '')}/${env.S3_BUCKET}`;
	const uploads: PendingUpload[] = [];
	let marker: PendingUploadMarker | undefined;

	do {
		const url = new URL(base);
		url.searchParams.set('uploads', '');
		if (marker) {
			url.searchParams.set('key-marker', marker.keyMarker);
			url.searchParams.set('upload-id-marker', marker.uploadIdMarker);
		}

		const response = await client.fetch(url.toString());
		const xml = await response.text();
		if (!response.ok) throw new Error('Could not list multipart uploads');

		const page = parsePendingUploads(xml);
		uploads.push(...page.uploads);
		marker = page.next;
	} while (marker);

	return uploads;
}

function escapeXml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
