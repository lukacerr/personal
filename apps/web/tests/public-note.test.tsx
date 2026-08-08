// @vitest-environment happy-dom

import type { Block } from '@blocknote/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicNote from '@web/routes/public.notes';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getPublicNote = vi.hoisted(() => vi.fn());

vi.mock('@web/lib/api', () => ({
	api: { public: { notes: (params: { id: string }) => getPublicNote(params) } },
}));

vi.mock('@blocknote/react', async (importOriginal) => ({
	...(await importOriginal<typeof import('@blocknote/react')>()),
	useCreateBlockNote: () => ({ document: [] }),
}));

vi.mock('@blocknote/shadcn', () => ({
	BlockNoteView: ({ editable }: { editable?: boolean }) => (
		<div data-testid="blocknote" data-editable={String(editable)} />
	),
}));

const content = [
	{
		id: 'block-1',
		type: 'paragraph',
		props: {
			backgroundColor: 'default',
			textAlignment: 'left',
			textColor: 'default',
		},
		content: [{ type: 'text', text: 'Shared body', styles: {} }],
		children: [],
	},
] as Block[];

function renderRoute(noteId = 'note-1') {
	const Stub = createRoutesStub([
		{ path: '/public/notes', Component: PublicNote },
	]);
	return render(<Stub initialEntries={[`/public/notes?note=${noteId}`]} />);
}

describe('Public note', () => {
	beforeEach(() => {
		getPublicNote.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders a shared note read-only, with no app shell around it', async () => {
		getPublicNote.mockReturnValue({
			get: async () => ({
				status: 200,
				data: { id: 'note-1', title: 'Linear algebra', content },
			}),
		});

		renderRoute();

		expect(
			await screen.findByRole('heading', { name: 'Linear algebra' }),
		).toBeTruthy();
		expect(screen.getByTestId('blocknote').dataset.editable).toBe('false');
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
		expect(document.title).toContain('Linear algebra');
	});

	it('says nothing about why a note is unavailable', async () => {
		getPublicNote.mockReturnValue({
			get: async () => ({
				status: 404,
				data: null,
			}),
		});

		renderRoute();

		expect(
			await screen.findByText(/not available/i, { exact: false }),
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
	});

	it('offers a retry instead of spinning forever when the request fails', async () => {
		const user = userEvent.setup();
		getPublicNote.mockReturnValue({
			get: async () => {
				throw new TypeError('Failed to fetch');
			},
		});

		renderRoute();

		const retry = await screen.findByRole('button', { name: 'Try again' });
		getPublicNote.mockReturnValue({
			get: async () => ({
				status: 200,
				data: { id: 'note-1', title: 'Recovered', content },
			}),
		});
		await user.click(retry);

		await waitFor(() =>
			expect(screen.getByRole('heading', { name: 'Recovered' })).toBeTruthy(),
		);
	});
});
