// @vitest-environment happy-dom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentThreadRail } from '@web/components/agent/agent-thread-rail';
import type { AgentThread } from '@web/lib/agent-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * happy-dom ships no `IntersectionObserver`, and even in a real browser nothing
 * ever intersects in a layout-less test. The stub keeps every instance so a
 * test can fire the callback by hand and inspect the root it was given.
 */
type ObserverRecord = {
	fire: (isIntersecting: boolean) => void;
	root: Element | Document | null;
	rootMargin: string;
	targets: Element[];
	disconnected: boolean;
};

let observers: ObserverRecord[] = [];

function stubIntersectionObserver() {
	observers = [];
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			private readonly record: ObserverRecord;

			constructor(
				callback: (
					entries: { isIntersecting: boolean; target: Element }[],
				) => void,
				options?: { root?: Element | Document | null; rootMargin?: string },
			) {
				this.record = {
					fire: (isIntersecting) => {
						if (this.record.disconnected) return;
						callback(
							this.record.targets.map((target) => ({
								isIntersecting,
								target,
							})),
						);
					},
					root: options?.root ?? null,
					rootMargin: options?.rootMargin ?? '0px',
					targets: [],
					disconnected: false,
				};
				observers.push(this.record);
			}

			observe(target: Element) {
				this.record.targets.push(target);
			}

			unobserve(target: Element) {
				this.record.targets = this.record.targets.filter(
					(entry) => entry !== target,
				);
			}

			disconnect() {
				this.record.disconnected = true;
			}

			takeRecords() {
				return [];
			}
		},
	);
}

function intersect() {
	act(() => {
		for (const observer of observers) observer.fire(true);
	});
}

beforeEach(stubIntersectionObserver);

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

function makeThreads(count: number): AgentThread[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `thread-${index}`,
		title: `Conversation ${index}`,
		createdAt: 1_700_000_000_000 + index,
		updatedAt: 1_700_000_000_000 + index,
	}));
}

function renderRail(
	overrides: Partial<Parameters<typeof AgentThreadRail>[0]> = {},
) {
	const props = {
		threads: makeThreads(3),
		loading: false,
		loadingMore: false,
		loadMoreError: undefined,
		hasMore: false,
		query: '',
		onSelect: vi.fn(),
		onNew: vi.fn(),
		onRetry: vi.fn(),
		onRename: vi.fn(),
		onDelete: vi.fn(),
		onGenerateTitle: vi.fn(),
		onSelectionChange: vi.fn(),
		onSelectionLimit: vi.fn(),
		onDeleteSelected: vi.fn(),
		onLoadMore: vi.fn(),
		onQueryChange: vi.fn(),
		...overrides,
	};
	const { rerender } = render(<AgentThreadRail {...props} />);
	return {
		...props,
		rerender: (next: Partial<Parameters<typeof AgentThreadRail>[0]>) =>
			rerender(<AgentThreadRail {...props} {...next} />),
	};
}

const searchField = () =>
	screen.getByLabelText('Search conversations by title');

describe('the title filter', () => {
	/**
	 * The filter is a server query: one request per burst of keystrokes, not
	 * one per key.
	 */
	it('waits for typing to settle before reporting a query', async () => {
		const props = renderRail();

		// Two keystrokes back to back: whatever the debounce does, it must not
		// have reported anything by the time this assertion runs.
		fireEvent.change(searchField(), { target: { value: 'bu' } });
		fireEvent.change(searchField(), { target: { value: 'bud' } });
		expect(props.onQueryChange).not.toHaveBeenCalled();

		await waitFor(() => expect(props.onQueryChange).toHaveBeenCalledTimes(1));
		expect(props.onQueryChange).toHaveBeenCalledWith('bud');
	});

	/** Clearing it from the outside has to reach the field, or it lies. */
	it('adopts a query changed from outside', () => {
		const rail = renderRail({ query: 'budget' });
		expect(searchField()).toHaveProperty('value', 'budget');

		rail.rerender({ query: '' });
		expect(searchField()).toHaveProperty('value', '');
	});
});

describe('the empty states', () => {
	it('separates an empty index from an empty result set', async () => {
		const user = userEvent.setup();
		const props = renderRail({ threads: [], query: 'budget' });

		expect(screen.getByText(/no conversation titles match/i)).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(props.onQueryChange).toHaveBeenCalledWith('');

		cleanup();
		renderRail({ threads: [], query: '' });
		expect(screen.getByText('No conversations yet.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
	});
});

describe('the selected row', () => {
	it('is the current item for assistive technology', () => {
		renderRail({ selectedId: 'thread-1' });

		expect(
			screen
				.getByRole('button', { name: 'Conversation 1' })
				.getAttribute('aria-current'),
		).toBe('true');
		expect(
			screen
				.getByRole('button', { name: 'Conversation 0' })
				.getAttribute('aria-current'),
		).toBeNull();
	});
});

describe('busy row actions', () => {
	it('disables navigation, new chat, shift selection, and row actions during a turn', async () => {
		const props = renderRail({ interactionBusy: true });
		const row = screen.getByRole('button', { name: 'Conversation 1' });
		const actions = screen.getByRole('button', {
			name: 'Actions for Conversation 1',
		});
		expect(row.hasAttribute('disabled')).toBe(true);
		expect(actions.hasAttribute('disabled')).toBe(true);
		expect(
			screen.getByRole('button', { name: 'New chat' }).hasAttribute('disabled'),
		).toBe(true);

		fireEvent.click(row, { shiftKey: true });
		await userEvent.click(actions);
		expect(props.onSelect).not.toHaveBeenCalled();
		expect(props.onSelectionChange).not.toHaveBeenCalled();
		expect(screen.queryByRole('menu')).toBeNull();
	});

	/**
	 * The generation is a full LLM round trip, so the row it belongs to has to
	 * say it is working: without this the menu closed and nothing happened for
	 * seconds while every other row's mutations were disabled by an id nothing
	 * on screen was ever compared against.
	 */
	it('marks the generating row and renames its own menu item', async () => {
		renderRail({ generatingTitleId: 'thread-1' });

		const generating = screen.getByRole('button', { name: 'Conversation 1' });
		expect(generating.getAttribute('aria-busy')).toBe('true');
		expect(generating.querySelector('[data-slot="spinner"]')).not.toBeNull();

		const idle = screen.getByRole('button', { name: 'Conversation 2' });
		expect(idle.getAttribute('aria-busy')).toBeNull();
		expect(idle.querySelector('[data-slot="spinner"]')).toBeNull();

		await userEvent.click(
			screen.getByRole('button', { name: 'Actions for Conversation 1' }),
		);
		expect(
			await screen.findByRole('menuitem', { name: 'Generating title…' }),
		).toBeTruthy();
		expect(
			screen.queryByRole('menuitem', { name: 'Generate title' }),
		).toBeNull();
	});

	it('disables select, rename, generate, and delete while a title is generating', async () => {
		const props = renderRail({ generatingTitleId: 'thread-0' });
		fireEvent.click(screen.getByRole('button', { name: 'Conversation 2' }), {
			shiftKey: true,
		});
		expect(props.onSelectionChange).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole('button', { name: 'Actions for Conversation 1' }),
		);
		for (const name of ['Select', 'Generate title', 'Rename', 'Delete']) {
			expect(
				(await screen.findByRole('menuitem', { name })).getAttribute(
					'aria-disabled',
				),
			).toBe('true');
		}
	});
});

describe('bulk selection', () => {
	it('selects a contiguous loaded range with shift-click from the anchor', () => {
		const props = renderRail({ selected: new Set(['thread-0']) });
		fireEvent.click(screen.getByRole('button', { name: 'Conversation 2' }), {
			shiftKey: true,
		});
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			new Set(['thread-0', 'thread-1', 'thread-2']),
		);
	});

	it('offers a menu selection path and visible checkboxes in selection mode', async () => {
		const props = renderRail();
		await userEvent.click(
			screen.getByRole('button', { name: 'Actions for Conversation 1' }),
		);
		await userEvent.click(
			await screen.findByRole('menuitem', { name: 'Select' }),
		);
		expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['thread-1']));

		props.rerender({ selected: new Set(['thread-1']) });
		expect(screen.getAllByRole('checkbox')).toHaveLength(3);
		fireEvent.click(
			screen.getByRole('checkbox', { name: 'Select Conversation 2' }),
		);
		expect(props.onSelectionChange).toHaveBeenLastCalledWith(
			new Set(['thread-1', 'thread-2']),
		);
	});

	it('reports clear and destructive actions for the selected count', async () => {
		const props = renderRail({ selected: new Set(['thread-0', 'thread-1']) });
		await userEvent.click(
			screen.getByRole('button', { name: 'Clear selection' }),
		);
		expect(props.onSelectionChange).toHaveBeenCalledWith(new Set());
		await userEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
		expect(props.onDeleteSelected).toHaveBeenCalledTimes(1);
	});

	it('caps a shift-selected range at 100 and reports the limit', () => {
		const threads = makeThreads(120);
		const props = renderRail({
			threads,
			selected: new Set(['thread-0']),
		});
		fireEvent.click(screen.getByRole('button', { name: 'Conversation 119' }), {
			shiftKey: true,
		});
		const selectionChange = vi.mocked(props.onSelectionChange);
		const selected = selectionChange.mock.calls[0]?.[0] as Set<string>;
		expect(selected.size).toBe(100);
		expect(props.onSelectionLimit).toHaveBeenCalledTimes(1);
	});
});

describe('auto-pagination', () => {
	it('asks for the next page when the tail comes into view', () => {
		const props = renderRail({ hasMore: true });

		expect(observers).toHaveLength(1);
		const [observer] = observers;
		// The rail scrolls internally, so the root must be that container — the
		// element the sentinel lives in, never the viewport.
		expect(observer.targets).toHaveLength(1);
		expect(
			observer.root instanceof HTMLElement &&
				observer.root.contains(observer.targets[0]),
		).toBe(true);
		expect(observer.rootMargin).toBe('200px');

		intersect();
		expect(props.onLoadMore).toHaveBeenCalledTimes(1);
	});

	it('does not ask again while a page is already in flight', () => {
		const props = renderRail({ hasMore: true, loadingMore: true });

		intersect();
		expect(props.onLoadMore).not.toHaveBeenCalled();
	});

	it('watches nothing once the index is exhausted', () => {
		const props = renderRail({ hasMore: false });

		intersect();
		expect(props.onLoadMore).not.toHaveBeenCalled();
	});

	it('stops observing after a failed page and exposes an explicit retry', async () => {
		const props = renderRail({
			hasMore: true,
			loadMoreError: 'Could not load more conversations.',
		});

		intersect();
		expect(props.onLoadMore).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole('button', { name: 'Try loading more' }),
		);
		expect(props.onLoadMore).toHaveBeenCalledTimes(1);
	});
});
