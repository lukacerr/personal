// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/storage-api', () => ({
	getFileLink: vi.fn(() => new Promise<string>(() => undefined)),
}));

afterEach(cleanup);

describe('Storage preview', () => {
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
