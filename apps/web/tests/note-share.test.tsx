// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteShare } from '@web/components/notes/note-share';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function renderShare(overrides: Partial<Parameters<typeof NoteShare>[0]> = {}) {
	render(
		<NoteShare
			noteId="0198da00-0000-7000-8000-000000000000"
			isPublic
			canPublish
			viewCount={0}
			onChange={vi.fn(async () => true)}
			{...overrides}
		/>,
	);
}

describe('Note share', () => {
	it('tells how many times the public link was read', async () => {
		const user = userEvent.setup();
		renderShare({ viewCount: 7 });

		await user.click(screen.getByRole('button', { name: 'Share note' }));

		expect(await screen.findByText('7 views')).toBeTruthy();
	});

	it('speaks of a single view in the singular', async () => {
		const user = userEvent.setup();
		renderShare({ viewCount: 1 });

		await user.click(screen.getByRole('button', { name: 'Share note' }));

		expect(await screen.findByText('1 view')).toBeTruthy();
	});

	it('shows no view count while the note is private', async () => {
		const user = userEvent.setup();
		renderShare({ isPublic: false, viewCount: 7 });

		await user.click(screen.getByRole('button', { name: 'Share note' }));

		expect(screen.queryByText(/views?$/)).toBeNull();
	});
});
