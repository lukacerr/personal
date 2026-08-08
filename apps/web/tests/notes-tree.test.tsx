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

function renderTree(props: { refreshing: boolean; onRefresh: () => void }) {
	return render(
		<NotesTree
			notes={notes}
			selectedId="note-1"
			preferences={{ fontSize: 'medium', margins: 'medium' }}
			setPreference={vi.fn()}
			refreshing={props.refreshing}
			onRefresh={props.onRefresh}
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
});
