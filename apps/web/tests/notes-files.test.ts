// @vitest-environment happy-dom
import {
	attachmentOutcome,
	pastedImageName,
	splitPastedImages,
} from '@web/lib/notes-files';
import { describe, expect, it } from 'vitest';

/**
 * The failure this exists to stop: BlockNote parses a pasted `<img>` into its
 * own image block, whose reference is a URL stored inside the note. That image
 * is hotlinked somewhere else, is invisible to Storage, and travels to anyone
 * the note is shared with.
 */
describe('Pasted markup', () => {
	it('lifts a lone image out of the markup', () => {
		expect(
			splitPastedImages('<img src="https://example.com/a.png" alt="a">'),
		).toEqual({ html: '', sources: ['https://example.com/a.png'] });
	});

	it('keeps whatever else was copied so the paste still lands', () => {
		const { html, sources } = splitPastedImages(
			'<p>Before</p><img src="https://example.com/a.png"><p>After</p>',
		);

		expect(sources).toEqual(['https://example.com/a.png']);
		expect(html).toBe('<p>Before</p><p>After</p>');
	});

	it('leaves markup with no images alone', () => {
		expect(splitPastedImages('<p>Just words</p>')).toEqual({
			html: '<p>Just words</p>',
			sources: [],
		});
	});

	it('ignores an image with nothing to fetch', () => {
		expect(splitPastedImages('<img alt="broken">').sources).toEqual([]);
	});

	it('takes every image, not just the first', () => {
		expect(
			splitPastedImages('<img src="one.png"><img src="two.png">').sources,
		).toEqual(['one.png', 'two.png']);
	});
});

/**
 * `uploadNoteFiles` quietly drops the files that failed unless all of them
 * did, so a toast that counts what was selected overstates what happened. The
 * success message counts what was actually attached, and the difference is a
 * failure of its own.
 */
describe('Attachment outcome', () => {
	it('names a single file that fully attached', () => {
		expect(attachmentOutcome(['photo.png'], 1)).toEqual({
			success: '“photo.png” attached.',
			failure: undefined,
		});
	});

	it('counts a batch that fully attached', () => {
		expect(attachmentOutcome(['a.png', 'b.png'], 2)).toEqual({
			success: '2 files attached.',
			failure: undefined,
		});
	});

	it('reports the files that were dropped along the way', () => {
		expect(attachmentOutcome(['a.png', 'b.png', 'c.png'], 1)).toEqual({
			success: '1 file attached.',
			failure: '2 files could not be attached.',
		});
	});

	it('singularises a lone failure', () => {
		expect(attachmentOutcome(['a.png', 'b.png'], 1).failure).toBe(
			'1 file could not be attached.',
		);
	});
});

describe('Pasted image names', () => {
	it.each([
		['https://example.com/photos/sunset.jpg', 'image/jpeg', 'sunset.jpg'],
		['https://example.com/a%20b.png', 'image/png', 'a b.png'],
		// A URL that names nothing usable still has to produce a filename.
		['https://example.com/download?id=7', 'image/webp', 'pasted-image.webp'],
		['https://example.com/', 'image/png', 'pasted-image.png'],
		['not a url at all', 'image/svg+xml', 'pasted-image.svg'],
	])('names %s as %s', (source, contentType, expected) => {
		expect(pastedImageName(source, contentType)).toBe(expected);
	});
});
