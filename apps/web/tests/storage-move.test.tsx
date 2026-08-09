// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StorageMove } from '@web/components/storage/storage-move';
import type { StoredFile } from '@web/lib/storage-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const file = {
	id: 'file-1',
	name: 'report.pdf',
	path: 'work',
	contentType: 'application/pdf',
	size: 42,
	isPublic: false,
	createdAt: 0,
	updatedAt: 0,
} as StoredFile;

describe('Storage move dialog', () => {
	it('offers Root and every real folder as pointer and keyboard alternatives to drag', () => {
		render(
			<StorageMove
				target={{ kind: 'files', files: [file] }}
				folders={[null, 'personal', 'work', 'work/reports']}
				onClose={vi.fn()}
				onMove={vi.fn()}
			/>,
		);

		expect(screen.getByRole('option', { name: /Root/ })).toBeTruthy();
		expect(screen.getByRole('option', { name: /work\/reports/ })).toBeTruthy();
	});

	it('moves to the selected folder and closes after success', async () => {
		const user = userEvent.setup();
		const onMove = vi.fn(async () => undefined);
		const onClose = vi.fn();
		render(
			<StorageMove
				target={{ kind: 'files', files: [file] }}
				folders={[null, 'work', 'work/reports']}
				onClose={onClose}
				onMove={onMove}
			/>,
		);

		await user.click(screen.getByRole('option', { name: /work\/reports/ }));
		await user.click(screen.getByRole('button', { name: 'Move here' }));

		expect(onMove).toHaveBeenCalledWith('work/reports');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('keeps a conflict visible in the open dialog', async () => {
		const user = userEvent.setup();
		render(
			<StorageMove
				target={{ kind: 'files', files: [file] }}
				folders={[null, 'work']}
				onClose={vi.fn()}
				onMove={vi.fn(async () => 'A file with this name already exists.')}
			/>,
		);

		await user.click(screen.getByRole('option', { name: /Root/ }));
		await user.click(screen.getByRole('button', { name: 'Move here' }));

		expect(screen.getByRole('alert').textContent).toContain('already exists');
	});

	/**
	 * Drag is not the only way to move a folder, and the dialog that replaces it
	 * has to refuse what dragging refuses: a folder cannot land inside itself.
	 */
	it('never offers a folder a destination inside its own subtree', () => {
		render(
			<StorageMove
				target={{ kind: 'folder', name: 'work', path: 'work' }}
				folders={[null, 'personal', 'work', 'work/reports']}
				onClose={vi.fn()}
				onMove={vi.fn()}
			/>,
		);

		expect(screen.getByRole('option', { name: /personal/ })).toBeTruthy();
		expect(screen.queryByRole('option', { name: /work\/reports/ })).toBeNull();
		expect(screen.queryByRole('option', { name: /^work$/ })).toBeNull();
		// It is already at the root, so moving it there would do nothing.
		expect(screen.queryByRole('option', { name: /Root/ })).toBeNull();
	});

	it('moves into a new path typed by the user', async () => {
		const user = userEvent.setup();
		const onMove = vi.fn(async () => undefined);
		render(
			<StorageMove
				target={{ kind: 'files', files: [file] }}
				folders={[null, 'work']}
				onClose={vi.fn()}
				onMove={onMove}
			/>,
		);

		await user.type(
			screen.getByPlaceholderText('Full path from Storage root…'),
			'archive/2027',
		);
		await user.click(screen.getByRole('option', { name: /Move to new path/ }));
		await user.click(screen.getByRole('button', { name: 'Move here' }));

		expect(onMove).toHaveBeenCalledWith('archive/2027');
	});
});
