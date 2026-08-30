/**
 * Pure helpers behind the storage system: key derivation, header encoding,
 * upload planning, pagination and the parsing of S3's XML answers. Nothing here
 * reaches for the network, the database or the environment on its own, so all of
 * it is testable in isolation.
 */

const MIB = 1024 * 1024;

/** Largest object R2 accepts, and the ceiling every upload plan is built under. */
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * MIB;

/** Smallest part S3 accepts for anything but the final part of an upload. */
const MIN_PART_SIZE = 5 * MIB;

/** Default part size, and the threshold above which an upload goes multipart. */
const DEFAULT_PART_SIZE = 8 * MIB;

/** Hard cap S3 places on the number of parts in a single multipart upload. */
export const MAX_PARTS = 10_000;

/** Parts signed per request, so a huge upload never asks for thousands at once. */
export const MAX_PARTS_PER_REQUEST = 50;

/** Files reserved per request; the client splits a larger selection itself. */
export const MAX_UPLOADS_PER_REQUEST = 100;

/**
 * How long a reservation survives without progress. Renewed every time parts
 * are signed, so an upload that is still moving keeps its name held, and one
 * that stopped expires on its own with nothing left to clean up.
 */
export const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

/** Everything this app stores lives under here, and nothing else does. */
export const OBJECT_PREFIX = 'files/';

/** The key never changes, so renaming and moving a file never touch storage. */
export function objectKey(id: string) {
	return `${OBJECT_PREFIX}${id}`;
}

/**
 * Derived artifacts (today: the PDF the agent's read tool converts an Office
 * file into) live outside `OBJECT_PREFIX` on purpose: reconcile only walks
 * `files/`, so a derivative can never be mistaken for an orphaned upload.
 */
export const DERIVED_PREFIX = 'derived/';

/**
 * Immutable like the source object: file bytes never change under an id, so a
 * conversion done once is valid forever. Deleting the file deletes this too.
 */
export function derivedPdfKey(id: string) {
	return `${DERIVED_PREFIX}${id}/converted.pdf`;
}

export type ObjectPage = {
	contents?: Array<{ key?: string }>;
	isTruncated?: boolean;
	nextContinuationToken?: string;
};

/**
 * Every id storage holds, paged to the end of the bucket.
 *
 * The token that advances is `nextContinuationToken`; `continuationToken` is
 * merely the one the request carried, so reading that one ends the loop after a
 * single page. That failure is silent and expensive: reconciliation compares
 * this listing against the table, and a listing cut short at a thousand keys
 * makes every file past it look like it lost its object.
 */
export async function collectObjectIds(
	listPage: (continuationToken?: string) => Promise<ObjectPage>,
) {
	const ids: string[] = [];
	let continuationToken: string | undefined;

	do {
		const page = await listPage(continuationToken);
		for (const entry of page.contents ?? [])
			if (entry.key?.startsWith(OBJECT_PREFIX))
				ids.push(entry.key.slice(OBJECT_PREFIX.length));
		continuationToken = page.isTruncated
			? page.nextContinuationToken
			: undefined;
	} while (continuationToken);

	return ids;
}

/** Prefixed so it can never collide with Drizzle's global query cache. */
export function uploadKey(id: string) {
	return `storage:upload:${id}`;
}

/**
 * Holds a name while its upload runs. Without it two concurrent uploads of the
 * same name would both transfer everything and only collide at the end.
 */
export function nameKey(path: string | null, name: string) {
	return `storage:name:${(path ?? '').toLocaleLowerCase()}/${name.toLocaleLowerCase()}`;
}

/**
 * Both forms of the filename, per RFC 6266: a quoted ASCII fallback for old
 * clients and the percent-encoded UTF-8 form everything modern reads. The
 * fallback is stripped of quotes, backslashes and control characters, because a
 * name is user input and a raw newline in a header is header injection.
 */
export function contentDisposition(
	disposition: 'inline' | 'attachment',
	name: string,
) {
	const ascii =
		name.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '') || 'download';
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export type UploadPlan = {
	mode: 'single' | 'multipart';
	partSize: number;
	partCount: number;
};

/**
 * Chooses how a file of this size gets uploaded. The client never picks: the
 * part size grows only as far as it must to stay under the part limit, so any
 * size up to R2's maximum is expressible without ever going below the 5 MiB
 * minimum S3 requires.
 */
export function planUpload(size: number): UploadPlan {
	const required = Math.ceil(Math.ceil(size / MAX_PARTS) / MIB) * MIB;
	const partSize = Math.max(DEFAULT_PART_SIZE, MIN_PART_SIZE, required);

	if (size <= partSize) return { mode: 'single', partSize, partCount: 1 };
	return { mode: 'multipart', partSize, partCount: Math.ceil(size / partSize) };
}

function tagContent(xml: string, tag: string) {
	return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

/** The upload id of a `CreateMultipartUpload` response, if it carries one. */
export function multipartUploadId(xml: string) {
	return tagContent(xml, 'UploadId');
}

export type UploadCompletion =
	| { ok: true }
	| { ok: false; code: string | undefined };

/**
 * S3 answers `CompleteMultipartUpload` with `200 OK` and puts the failure inside
 * the body, so trusting the status silently accepts a broken object. The body is
 * the only reliable answer.
 */
export function verifyCompletedUpload(
	status: number,
	xml: string,
): UploadCompletion {
	if (status < 200 || status >= 300 || xml.includes('<Error>'))
		return { ok: false, code: tagContent(xml, 'Code') };
	return { ok: true };
}

export type PendingUpload = {
	id: string;
	uploadId: string;
	initiatedAt: Date;
};

/** Where a truncated listing of multipart uploads has to resume from. */
export type PendingUploadMarker = {
	keyMarker: string;
	uploadIdMarker: string;
};

/**
 * One page of `ListMultipartUploads`. It is truncated like any other listing,
 * and its cursor is a pair of markers rather than a single token. Uploads under
 * a key this app does not own are skipped: aborting those is not ours to do.
 */
export function parsePendingUploads(xml: string): {
	uploads: PendingUpload[];
	next?: PendingUploadMarker;
} {
	const uploads = [...xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)].flatMap(
		(match) => {
			const entry = match[1] ?? '';
			const key = tagContent(entry, 'Key');
			const uploadId = tagContent(entry, 'UploadId');
			const id = key?.startsWith(OBJECT_PREFIX)
				? key.slice(OBJECT_PREFIX.length)
				: undefined;
			return id && uploadId
				? [
						{
							id,
							uploadId,
							initiatedAt: new Date(tagContent(entry, 'Initiated') ?? 0),
						},
					]
				: [];
		},
	);

	const keyMarker = tagContent(xml, 'NextKeyMarker');
	const uploadIdMarker = tagContent(xml, 'NextUploadIdMarker');
	const truncated = tagContent(xml, 'IsTruncated') === 'true';

	return truncated && keyMarker && uploadIdMarker
		? { uploads, next: { keyMarker, uploadIdMarker } }
		: { uploads };
}
