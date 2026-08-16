// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StorageList } from '@web/components/storage/storage-list';
import type { StoredFile } from '@web/lib/storage-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function file(overrides: Partial<StoredFile> = {}) {
	return {
		id: 'file-1',
		name: 'report.pdf',
		path: 'work',
		contentType: 'application/pdf',
		size: 2048,
		isPublic: false,
		viewCount: 0,
		createdAt: Date.UTC(2026, 0, 15),
		updatedAt: Date.UTC(2026, 0, 15),
		...overrides,
	} as StoredFile;
}

function renderList(
	overrides: Partial<Parameters<typeof StorageList>[0]> = {},
) {
	const props = {
		folders: [],
		files: [file()],
		currentFolder: 'work',
		resultMode: false,
		selectedIds: new Set<string>(),
		onToggleSelected: vi.fn(),
		onSelectAll: vi.fn(),
		onOpenFolder: vi.fn(),
		onNavigatePath: vi.fn(),
		onPreview: vi.fn(),
		onDownload: vi.fn(),
		onShare: vi.fn(),
		onMove: vi.fn(),
		onDelete: vi.fn(),
		onRenameFile: vi.fn(async () => undefined),
		onRenameFolder: vi.fn(async () => undefined),
		onDeleteFolder: vi.fn(),
		onMoveFolder: vi.fn(),
		onDropFiles: vi.fn(async () => 'moved' as const),
		onDropFolder: vi.fn(async () => 'moved' as const),
		...overrides,
	};
	// The shell's `<main>` is focusable, and the list has to stay usable inside
	// it: rendering the table bare hides anything that walks up the ancestry.
	render(
		<main tabIndex={-1}>
			<StorageList {...props} />
		</main>,
	);
	return props;
}

describe('Storage list', () => {
	it('shows an empty folder as empty instead of a blank panel', () => {
		renderList({ files: [], folders: [], currentFolder: null });

		expect(screen.getByText('This folder is empty')).toBeTruthy();
	});

	it('distinguishes an empty search from an empty folder', () => {
		renderList({ files: [], folders: [], resultMode: true });

		expect(screen.getByText('No matches')).toBeTruthy();
		expect(screen.getByText(/different title, path or filter/)).toBeTruthy();
	});

	it('shows a parent row even when a nested folder has no files', async () => {
		const user = userEvent.setup();
		const props = renderList({
			files: [],
			folders: [],
			currentFolder: 'work/deep',
		});

		await user.click(
			screen.getByRole('button', { name: 'Go to parent folder' }),
		);

		expect(props.onNavigatePath).toHaveBeenCalledWith('work');
		expect(screen.queryByText('This folder is empty')).toBeNull();
	});

	it('opens a folder when its name is activated', async () => {
		const user = userEvent.setup();
		const props = renderList({ folders: ['reports'], files: [] });
		const [folderButton] = screen.getAllByRole('button', { name: 'reports' });
		if (!folderButton) throw new Error('Expected desktop folder button');

		await user.click(folderButton);

		expect(props.onOpenFolder).toHaveBeenCalledWith('reports');
	});

	it('previews a file when its name is activated', async () => {
		const user = userEvent.setup();
		const props = renderList();
		const [fileButton] = screen.getAllByRole('button', { name: 'report.pdf' });
		if (!fileButton) throw new Error('Expected desktop file button');

		await user.click(fileButton);

		expect(props.onPreview).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'file-1' }),
		);
	});

	/**
	 * Hunting for the exact width of a filename to open a file is a target the
	 * size of the text; the row is the thing being pointed at.
	 */
	it('opens a file from anywhere in its row, not only its name', async () => {
		const user = userEvent.setup();
		const props = renderList();

		await user.click(screen.getByText('2 KB'));

		expect(props.onPreview).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'file-1' }),
		);
	});

	it('opens a folder from anywhere in its row', async () => {
		const user = userEvent.setup();
		const props = renderList({ folders: ['reports'], files: [] });

		await user.click(screen.getByText('Folder'));

		expect(props.onOpenFolder).toHaveBeenCalledWith('reports');
	});

	/**
	 * The type of a file is what storage recorded, not what its name suggests:
	 * dropping the extension while renaming must not blank the column out.
	 */
	it('reads the type from the recorded content type', () => {
		renderList({
			files: [file({ name: 'ejemplo', contentType: 'image/png' })],
		});

		expect(screen.getByText('PNG')).toBeTruthy();
	});

	/**
	 * Deleting is destructive, so it asks the route to confirm rather than
	 * doing it on the spot.
	 */
	it('routes deletion through a confirmation instead of acting immediately', async () => {
		const user = userEvent.setup();
		const props = renderList();

		await user.click(screen.getByRole('button', { name: 'Delete report.pdf' }));

		expect(props.onDelete).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'file-1' }),
		);
	});

	it('keeps file actions visible in the desktop table and renames inline', async () => {
		const user = userEvent.setup();
		const props = renderList();

		expect(
			screen.getByRole('button', { name: 'Download report.pdf' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Share report.pdf' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Move or drag report.pdf' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Delete report.pdf' }),
		).toBeTruthy();
		await user.click(screen.getByRole('button', { name: 'Rename report.pdf' }));
		expect(
			screen.getByRole('textbox', { name: 'Rename report.pdf' }),
		).toBeTruthy();
		expect(props.onRenameFile).not.toHaveBeenCalled();
	});

	it('commits inline rename with Enter', async () => {
		const user = userEvent.setup();
		const props = renderList();
		await user.click(screen.getByRole('button', { name: 'Rename report.pdf' }));
		const input = screen.getByRole('textbox', { name: 'Rename report.pdf' });
		await user.clear(input);
		await user.type(input, 'renamed.pdf{Enter}');

		expect(props.onRenameFile).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'file-1' }),
			'renamed.pdf',
		);
	});

	it('selects a file without opening it', async () => {
		const user = userEvent.setup();
		const props = renderList();
		const [checkbox] = screen.getAllByRole('checkbox', {
			name: 'Select report.pdf',
		});
		if (!checkbox) throw new Error('Expected a select control');

		await user.click(checkbox);

		expect(props.onToggleSelected).toHaveBeenCalledWith('file-1');
		expect(props.onPreview).not.toHaveBeenCalled();
	});

	/**
	 * Selecting is not a mode. Behind one, unticking the last file left the
	 * checkboxes on screen with every per-file action gone and nothing to act on:
	 * a state you can enter, empty out, and not leave.
	 */
	it('keeps every file action reachable while a file is selected', () => {
		renderList({ selectedIds: new Set(['file-1']) });

		expect(
			screen.getByRole('button', { name: 'Actions for report.pdf' }),
		).toBeTruthy();
		expect(
			screen.getAllByRole('checkbox', { name: 'Select report.pdf' }).length,
		).toBeGreaterThan(0);
	});

	/**
	 * Sharing is a property of the file's access, so it is offered where the
	 * access is shown rather than as one more icon in a row of icons.
	 */
	it.each([
		[true, 'Public'],
		[false, 'Private'],
	])(
		'shares a file from the badge that states its access',
		async (isPublic, label) => {
			const user = userEvent.setup();
			const props = renderList({ files: [file({ isPublic })] });
			const share = screen.getByRole('button', { name: 'Share report.pdf' });

			expect(share.textContent).toContain(label);
			await user.click(share);

			expect(props.onShare).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'file-1' }),
			);
		},
	);

	/**
	 * The count sits beside the access badge because it only means something
	 * while the file is reachable through its public link.
	 */
	it('shows how many times a public file was read beside its badge', () => {
		renderList({ files: [file({ isPublic: true, viewCount: 12 })] });

		expect(screen.getByText('12')).toBeTruthy();
		expect(screen.getByText('views')).toBeTruthy();
	});

	it('shows no read count for a private file', () => {
		renderList({ files: [file({ isPublic: false, viewCount: 12 })] });

		expect(screen.queryByText('12')).toBeNull();
		expect(screen.queryByText('views')).toBeNull();
	});

	it('offers a drag handle for folders as well as for files', () => {
		renderList({ folders: ['reports'], files: [] });

		expect(
			screen.getByRole('button', { name: 'Move or drag folder reports' }),
		).toBeTruthy();
	});

	it('shows a navigable path in recursive results', async () => {
		const user = userEvent.setup();
		const props = renderList({ resultMode: true });

		await user.click(screen.getByRole('button', { name: /^work$/ }));

		expect(props.onNavigatePath).toHaveBeenCalledWith('work');
	});

	/**
	 * The card layout is always mounted — `md:hidden` is CSS — so left
	 * unwindowed it renders every row and cancels out the table's
	 * virtualisation on exactly the lists that needed it.
	 */
	it('windows the card layout past the same threshold as the table', () => {
		const files = Array.from({ length: 500 }, (_, index) =>
			file({ id: `file-${index}`, name: `file-${index}.pdf` }),
		);
		renderList({ files });

		const cards = document.querySelectorAll('ul > li');
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.length).toBeLessThan(200);
	});

	it('offers folder actions separately from file actions', async () => {
		const user = userEvent.setup();
		const props = renderList({ folders: ['reports'], files: [] });

		await user.click(
			screen.getByRole('button', { name: 'Delete folder reports' }),
		);

		expect(props.onDeleteFolder).toHaveBeenCalledWith('reports');
	});
});
