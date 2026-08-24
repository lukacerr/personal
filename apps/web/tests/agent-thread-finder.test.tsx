// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	AgentThreadFinder,
	type ThreadFinderMatch,
} from '@web/components/agent/agent-thread-finder';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const matches: ThreadFinderMatch[] = [
	{
		id: 'm-1',
		position: 2,
		role: 'user',
		snippet: 'how do I migrate the schema without touching production',
	},
	{
		id: 'm-2',
		position: 3,
		role: 'assistant',
		snippet: 'Generate the migration and apply the SQL locally.',
	},
];

function renderFinder(
	overrides: Partial<React.ComponentProps<typeof AgentThreadFinder>> = {},
) {
	const props = {
		onSearch: vi.fn(),
		matches: [] as ThreadFinderMatch[],
		searching: false,
		loadingMore: false,
		hasMore: false,
		onJump: vi.fn(),
		onLoadMore: vi.fn(),
		...overrides,
	};
	render(<AgentThreadFinder {...props} />);
	return props;
}

async function openFinder() {
	await userEvent.click(
		screen.getByRole('button', { name: 'Search this conversation' }),
	);
	return await screen.findByPlaceholderText('Search this conversation…');
}

describe('the thread finder', () => {
	/**
	 * The keystrokes go in synchronously on purpose: what the debounce has to
	 * guarantee is that a burst of typing costs the parent one fetch, and real
	 * time between `userEvent` keystrokes would make that a race instead of an
	 * assertion.
	 */
	it('coalesces a burst of typing into one search', async () => {
		const props = renderFinder();
		const input = await openFinder();

		fireEvent.change(input, { target: { value: 'mig' } });
		fireEvent.change(input, { target: { value: 'migr' } });
		fireEvent.change(input, { target: { value: 'migrate' } });

		await waitFor(() => expect(props.onSearch).toHaveBeenCalledWith('migrate'));
		expect(props.onSearch).toHaveBeenCalledTimes(1);
	});

	/** Clearing is the signal to drop results, so it can't wait out a debounce. */
	it('reports an emptied field right away', async () => {
		const onSearch = vi.fn();
		renderFinder({ onSearch });
		const input = await openFinder();

		fireEvent.change(input, { target: { value: 'migrate' } });
		fireEvent.change(input, { target: { value: '' } });

		expect(onSearch).toHaveBeenCalledWith('');
		// The debounce still pending for 'migrate' has to be cancelled, not merely
		// outrun: otherwise the cleared field gets results a moment later.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(onSearch.mock.calls).toEqual([['']]);
	});

	it('jumps to the match the user picked and closes', async () => {
		const props = renderFinder({ matches });
		await openFinder();

		await userEvent.click(screen.getByText(matches[1].snippet));

		expect(props.onJump).toHaveBeenCalledWith(matches[1]);
		// Closing discards the search, so the owner is told to drop the results.
		expect(props.onSearch).toHaveBeenCalledWith('');
	});

	it('names who said each match', async () => {
		renderFinder({ matches });
		await openFinder();

		expect(screen.getByText('You')).toBeDefined();
		expect(screen.getByText('Agent')).toBeDefined();
	});

	it('says nothing matched only once there is a query', async () => {
		renderFinder();
		const input = await openFinder();

		expect(screen.getByText('Type to search this conversation.')).toBeDefined();

		fireEvent.change(input, { target: { value: 'zzz' } });

		expect(screen.getByText('No messages match.')).toBeDefined();
	});

	/** A failed search is inline state, not a toast: the popover owns it. */
	it('shows a failure inline', async () => {
		renderFinder({ error: 'Search failed. Check your connection.' });
		await openFinder();

		expect(
			screen.getByText('Search failed. Check your connection.'),
		).toBeDefined();
	});

	it('offers another page without replacing the matches already shown', async () => {
		const props = renderFinder({ matches, hasMore: true });
		await openFinder();

		expect(screen.getByText(matches[0].snippet)).toBeDefined();
		await userEvent.click(
			screen.getByRole('button', { name: 'Load more matches' }),
		);
		expect(props.onLoadMore).toHaveBeenCalledTimes(1);
		expect(screen.getByText(matches[0].snippet)).toBeDefined();
	});
});
