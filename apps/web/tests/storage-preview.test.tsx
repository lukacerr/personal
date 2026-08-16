// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { getFileLink } from '@web/lib/storage-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/storage-api', () => ({
	getFileLink: vi.fn(() => new Promise<string>(() => undefined)),
}));

// Braced on purpose: a hook that returns the mock hands vitest a "teardown"
// that calls `getFileLink()` and awaits its never-resolving promise.
beforeEach(() => {
	vi.mocked(getFileLink).mockClear();
});
afterEach(cleanup);

describe('Storage preview', () => {
	/**
	 * The route recomputes the previewed file with `.find(...)` over an array
	 * the store replaces on every mutation, so the same file arrives as a new
	 * object whenever anything else changes — renaming another file must not
	 * re-download the one being previewed.
	 */
	it('does not reload when the same file arrives as a new object', () => {
		const file = {
			id: 'image-1',
			name: 'photo.png',
			path: null,
			contentType: 'image/png',
			size: 1024,
			isPublic: false,
			viewCount: 0,
			uploadedFromNotes: false,
			createdAt: 0,
			updatedAt: 0,
		};
		const props = { onClose: vi.fn(), onDownload: vi.fn() };
		const view = render(<StoragePreview file={file} {...props} />);

		view.rerender(<StoragePreview file={{ ...file }} {...props} />);

		expect(getFileLink).toHaveBeenCalledTimes(1);
	});

	it('centres rendered Word pages inside the preview viewport', () => {
		render(
			<StoragePreview
				file={{
					id: 'document-1',
					name: 'document.docx',
					path: null,
					contentType:
						'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					size: 1024,
					isPublic: false,
					viewCount: 0,
					uploadedFromNotes: false,
					createdAt: 0,
					updatedAt: 0,
				}}
				onClose={vi.fn()}
				onDownload={vi.fn()}
			/>,
		);

		const documentPreview = Array.from(document.querySelectorAll('div')).find(
			(element) =>
				element.classList.contains('bg-white') &&
				element.classList.contains('p-6'),
		);

		expect(documentPreview?.className).toContain('items-center');
	});
});
