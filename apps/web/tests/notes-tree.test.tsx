// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotesTree } from '@web/components/notes/notes-tree';
import type { NoteSummary } from '@web/lib/notes-db';
import { afterEach, describe, expect, it, vi } from 'vitest';

const notes: NoteSummary[] = [
	{
		id: 'note-1',
		title: 'Saved note',
		path: null,
		isPublic: false,
		createdAt: 1,
		updatedAt: 1,
	},
];

function renderTree({
	refreshing,
	onRefresh,
	notes: items = notes,
	selectedId = 'note-1',
}: {
	refreshing: boolean;
	onRefresh: () => void;
	notes?: NoteSummary[];
	selectedId?: string | null;
}) {
	return render(
		<NotesTree
			notes={items}
			selectedId={selectedId}
			preferences={{ fontSize: 'medium', margins: 'medium' }}
			setPreference={vi.fn()}
			refreshing={refreshing}
			onRefresh={onRefresh}
			onSelect={vi.fn()}
			onCreate={vi.fn()}
			onRenameNote={vi.fn(async () => undefined)}
			onDeleteNote={vi.fn()}
			onRenameFolder={vi.fn()}
			onDeleteFolder={vi.fn()}
			onMoveNote={vi.fn(async () => 'moved' as const)}
		/>,
	);
}

afterEach(cleanup);

describe('NotesTree', () => {
	it('pulls the server state from its own refresh button', async () => {
		const user = userEvent.setup();
		const onRefresh = vi.fn();
		renderTree({ refreshing: false, onRefresh });

		await user.click(
			screen.getByRole('button', { name: 'Refresh from server' }),
		);
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('shows the refresh in progress', () => {
		renderTree({ refreshing: true, onRefresh: vi.fn() });

		const button = screen.getByRole('button', { name: 'Refresh from server' });
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.hasAttribute('disabled')).toBe(true);
	});

	// The marker used to sit on every public note at once, which read as noise
	// on the notes the reader was not looking at.
	it('keeps the public marker hidden until its note is selected or hovered', () => {
		const shared: NoteSummary[] = [{ ...notes[0], isPublic: true }];
		renderTree({ refreshing: false, onRefresh: vi.fn(), notes: shared });

		expect(screen.getByLabelText('Shared publicly').className).not.toContain(
			'opacity-0',
		);

		cleanup();
		renderTree({
			refreshing: false,
			onRefresh: vi.fn(),
			notes: shared,
			selectedId: null,
		});

		const marker = screen.getByLabelText('Shared publicly').className;
		expect(marker).toContain('opacity-0');
		expect(marker).toContain('group-hover/note:opacity-100');
	});
});
