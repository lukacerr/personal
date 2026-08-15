/**
 * BlockNote's own `file` key stays where it is. Overriding it would take over
 * the paste and drop handling of the built-in block, whose reference lives in
 * `props.url` — a stored URL, which is exactly what this block avoids.
 */
export const STORED_FILE_BLOCK_TYPE = 'storedFile';

/** Where an attachment lands, so the Storage root stays browsable. */
export const NOTES_UPLOAD_FOLDER = 'Notes';

/**
 * Separates the images out of pasted markup.
 *
 * Copying an image from a page puts markup on the clipboard, not a file, and
 * BlockNote turns that `<img>` into its own image block whose reference is a
 * URL living in the document — hotlinked to somewhere else, invisible to
 * Storage, and leaked to anyone the note is shared with. The images come out
 * to be imported properly, and whatever else was copied pastes as it was.
 */
export function splitPastedImages(html: string) {
	const parsed = new DOMParser().parseFromString(html, 'text/html');
	const images = [...parsed.querySelectorAll('img')];
	const sources = images
		.map((image) => image.getAttribute('src') ?? '')
		.filter((source) => source !== '');

	for (const image of images) image.remove();
	return { html: parsed.body.innerHTML.trim(), sources };
}

/** A name for an image that only ever had a URL. */
export function pastedImageName(source: string, contentType: string) {
	const extension = contentType.split('/')[1]?.split('+')[0] ?? 'png';
	const fallback = `pasted-image.${extension}`;
	try {
		const last = new URL(source, window.location.href).pathname
			.split('/')
			.at(-1);
		return last && /\.[a-z0-9]+$/i.test(last)
			? decodeURIComponent(last)
			: fallback;
	} catch {
		return fallback;
	}
}

/**
 * What to tell the user once an attachment batch settles.
 *
 * `uploadNoteFiles` quietly drops the files that failed unless all of them
 * did, so a message that counts the selection overstates what happened. The
 * success line counts what was actually attached — keeping the filename when
 * one file made it whole — and whatever was dropped is a failure of its own.
 */
export function attachmentOutcome(names: string[], attached: number) {
	const failed = names.length - attached;
	return {
		success:
			attached === 1 && names.length === 1
				? `“${names[0]}” attached.`
				: `${attached} ${attached === 1 ? 'file' : 'files'} attached.`,
		failure:
			failed > 0
				? `${failed} ${failed === 1 ? 'file' : 'files'} could not be attached.`
				: undefined,
	};
}

/**
 * What the block can be showing. `missing` and `broken` are different failures
 * worth telling apart: the first means the file was deleted, the second means
 * the row and the bucket disagree, which is what Reconcile exists for.
 */
export type StoredFileState =
	| 'empty'
	| 'loading'
	| 'ready'
	| 'missing'
	| 'broken'
	| 'unavailable'
	| 'failed';
