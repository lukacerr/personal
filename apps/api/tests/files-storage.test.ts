import { describe, expect, it } from 'bun:test';
import {
	collectObjectIds,
	contentDisposition,
	multipartUploadId,
	nameKey,
	objectKey,
	parsePendingUploads,
	planUpload,
	uploadKey,
	verifyCompletedUpload,
} from '@api/files-storage';

describe('Storage keys', () => {
	it('derives the object key from the id alone', () => {
		expect(objectKey('0199a1f0-0000-7000-8000-000000000001')).toBe(
			'files/0199a1f0-0000-7000-8000-000000000001',
		);
	});

	it('scopes upload state under its own prefix', () => {
		// Drizzle's query cache runs global on this same Redis, so storage keys
		// have to live somewhere it will never collide with.
		expect(uploadKey('0199a1f0-0000-7000-8000-000000000001')).toBe(
			'storage:upload:0199a1f0-0000-7000-8000-000000000001',
		);
	});

	it.each([
		[
			'a folder',
			'Work/Docs',
			'Report.PDF',
			'storage:name:work/docs/report.pdf',
		],
		['the root', null, 'Report.PDF', 'storage:name:/report.pdf'],
	])('reserves a name case-insensitively in %s', (_case, path, name, key) => {
		expect(nameKey(path, name)).toBe(key);
	});

	it('gives the same name in different folders different keys', () => {
		expect(nameKey('work', 'a.txt')).not.toBe(nameKey('work/deep', 'a.txt'));
	});
});

describe('Object listing', () => {
	/**
	 * Reconciliation compares this listing against the table, so a listing that
	 * stops early does not look empty: it looks like every file past the first
	 * page lost its object, and those rows get deleted.
	 */
	it('pages to the end of the bucket instead of stopping at the first response', async () => {
		const pages = [
			{
				contents: [{ key: 'files/a' }, { key: 'files/b' }],
				isTruncated: true,
				// The token for the next page, which is the only one that advances.
				nextContinuationToken: 'page-2',
				// What S3 echoes back: on the first request there was none to echo.
				continuationToken: undefined,
			},
			{
				contents: [{ key: 'files/c' }],
				isTruncated: false,
				continuationToken: 'page-2',
			},
		];
		const requested: Array<string | undefined> = [];

		const ids = await collectObjectIds(async (continuationToken) => {
			requested.push(continuationToken);
			const page = pages[requested.length - 1];
			if (!page) throw new Error('Asked for a page that was never offered');
			return page;
		});

		expect(ids).toEqual(['a', 'b', 'c']);
		expect(requested).toEqual([undefined, 'page-2']);
	});

	it('ignores keys that are not stored files', async () => {
		expect(
			await collectObjectIds(async () => ({
				contents: [{ key: 'files/a' }, { key: 'other/b' }, {}],
				isTruncated: false,
			})),
		).toEqual(['a']);
	});
});

describe('Content disposition', () => {
	it('carries a plain name in both forms', () => {
		expect(contentDisposition('attachment', 'report.pdf')).toBe(
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		);
	});

	it('percent-encodes a unicode name instead of emitting raw bytes', () => {
		const header = contentDisposition('inline', 'añoreport.pdf');

		expect(header).toContain(`filename*=UTF-8''a%C3%B1oreport.pdf`);
		// The ASCII fallback cannot hold the character, so it must not smuggle it.
		expect(header).toContain('filename="aoreport.pdf"');
	});

	/**
	 * A filename is user input. What makes it dangerous in a header is a line
	 * break, which would start a header of the attacker's choosing, or a bare
	 * quote, which would end the quoted string early.
	 */
	it('never lets a name break out of the header', () => {
		const header = contentDisposition(
			'attachment',
			'evil"\r\nX-Injected: yes.txt',
		);
		const fallback = /filename="([^"]*)"/.exec(header)?.[1];

		expect(header).not.toContain('\r');
		expect(header).not.toContain('\n');
		expect(fallback).toBe('evilX-Injected: yes.txt');
	});

	it('falls back to a usable name when nothing survives encoding', () => {
		expect(contentDisposition('attachment', '“”')).toContain(
			'filename="download"',
		);
	});
});

const MIB = 1024 * 1024;

describe('Upload planning', () => {
	it.each([
		['an empty-ish file', 1, 'single', 1],
		['a file at the threshold', 8 * MIB, 'single', 1],
		['a file just over it', 8 * MIB + 1, 'multipart', 2],
		['a 100 MiB file', 100 * MIB, 'multipart', 13],
	])('plans %s as %s', (_case, size, mode, partCount) => {
		const plan = planUpload(size);

		expect(plan.mode).toBe(mode as 'single' | 'multipart');
		expect(plan.partCount).toBe(partCount);
	});

	it('grows the part size instead of exceeding the part limit', () => {
		// S3 caps a multipart upload at 10.000 parts, so past a point the part
		// size has to grow or the upload becomes impossible to express.
		const plan = planUpload(5 * 1024 * 1024 * 1024 * 1024);

		expect(plan.partCount).toBeLessThanOrEqual(10_000);
		expect(plan.partSize).toBeGreaterThan(8 * MIB);
	});

	it('never plans a part below the 5 MiB minimum S3 enforces', () => {
		for (const size of [9 * MIB, 500 * MIB, 40 * 1024 * MIB])
			expect(planUpload(size).partSize).toBeGreaterThanOrEqual(5 * MIB);
	});

	it('covers the whole file with its parts', () => {
		for (const size of [8 * MIB + 1, 100 * MIB, 1023 * MIB]) {
			const { partSize, partCount } = planUpload(size);
			expect(partSize * partCount).toBeGreaterThanOrEqual(size);
			expect(partSize * (partCount - 1)).toBeLessThan(size);
		}
	});
});

describe('Multipart responses', () => {
	it('reads the upload id out of a create response', () => {
		expect(
			multipartUploadId(
				`<?xml version="1.0" encoding="UTF-8"?>
				<InitiateMultipartUploadResult>
					<Bucket>luka</Bucket><Key>files/x</Key>
					<UploadId>abc-123_XYZ</UploadId>
				</InitiateMultipartUploadResult>`,
			),
		).toBe('abc-123_XYZ');
	});

	it('reports a create response that carries no upload id', () => {
		expect(multipartUploadId('<Error><Code>AccessDenied</Code></Error>')).toBe(
			undefined,
		);
	});

	it('accepts a genuine completion', () => {
		expect(
			verifyCompletedUpload(
				200,
				'<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>',
			),
		).toEqual({ ok: true });
	});

	/**
	 * The trap that makes this function exist: S3 answers `200 OK` and puts the
	 * failure inside the body, so checking the status alone silently accepts a
	 * broken object.
	 */
	it('rejects a failure that arrived with a 200 status', () => {
		expect(
			verifyCompletedUpload(
				200,
				'<Error><Code>InvalidPart</Code><Message>One or more of the specified parts could not be found</Message></Error>',
			),
		).toEqual({ ok: false, code: 'InvalidPart' });
	});

	it('rejects a real error status too', () => {
		expect(
			verifyCompletedUpload(403, '<Error><Code>AccessDenied</Code></Error>'),
		).toEqual({ ok: false, code: 'AccessDenied' });
	});
});

describe('Pending upload listings', () => {
	it('reads the uploads of a page along with the markers that continue it', () => {
		expect(
			parsePendingUploads(`<ListMultipartUploadsResult>
				<Upload>
					<Key>files/019fe765-0000-7000-8000-000000000001</Key>
					<UploadId>upload-one</UploadId>
					<Initiated>2026-08-09T10:00:00.000Z</Initiated>
				</Upload>
				<Upload><Key>somewhere/else</Key><UploadId>upload-two</UploadId></Upload>
				<IsTruncated>true</IsTruncated>
				<NextKeyMarker>files/019fe765-0000-7000-8000-000000000001</NextKeyMarker>
				<NextUploadIdMarker>upload-one</NextUploadIdMarker>
			</ListMultipartUploadsResult>`),
		).toEqual({
			uploads: [
				{
					id: '019fe765-0000-7000-8000-000000000001',
					uploadId: 'upload-one',
					initiatedAt: new Date('2026-08-09T10:00:00.000Z'),
				},
			],
			next: {
				keyMarker: 'files/019fe765-0000-7000-8000-000000000001',
				uploadIdMarker: 'upload-one',
			},
		});
	});

	it('reports no continuation once the listing is complete', () => {
		expect(
			parsePendingUploads(
				'<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
			).next,
		).toBeUndefined();
	});
});
