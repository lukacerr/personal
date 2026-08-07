// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteFind } from '@web/components/notes/note-find';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

/** Props the component requires but a given test does not exercise. */
const inert = {
	mode: 'find' as const,
	replacement: '',
	focusRequest: 0,
	onModeChange: () => undefined,
	onReplacementChange: () => undefined,
	onReplace: () => undefined,
	onReplaceAll: () => undefined,
};

describe('NoteFind', () => {
	it('searches, navigates and closes from the keyboard', async () => {
		const user = userEvent.setup();
		const onQueryChange = vi.fn();
		const onNext = vi.fn();
		const onPrevious = vi.fn();
		const onClose = vi.fn();
		function Harness() {
			const [query, setQuery] = useState('');
			return (
				<NoteFind
					{...inert}
					query={query}
					resultCount={3}
					currentIndex={1}
					onQueryChange={(value) => {
						setQuery(value);
						onQueryChange(value);
					}}
					onNext={onNext}
					onPrevious={onPrevious}
					onClose={onClose}
				/>
			);
		}

		render(<Harness />);

		const input = screen.getByRole('searchbox', { name: 'Find in note' });
		expect(document.activeElement).toBe(input);
		expect(screen.getByText('2 / 3')).toBeTruthy();

		await user.type(input, 'plan');
		expect(onQueryChange).toHaveBeenLastCalledWith('plan');
		await user.keyboard('{Enter}');
		expect(onNext).toHaveBeenCalledOnce();
		await user.keyboard('{Shift>}{Enter}{/Shift}');
		expect(onPrevious).toHaveBeenCalledOnce();
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('expands replace and runs replace current or all', async () => {
		const user = userEvent.setup();
		const onReplacementChange = vi.fn();
		const onReplace = vi.fn();
		const onReplaceAll = vi.fn();
		const onModeChange = vi.fn();

		render(
			<NoteFind
				{...inert}
				mode="find"
				query="plan"
				replacement=""
				resultCount={2}
				currentIndex={0}
				onModeChange={onModeChange}
				onQueryChange={vi.fn()}
				onReplacementChange={onReplacementChange}
				onNext={vi.fn()}
				onPrevious={vi.fn()}
				onReplace={onReplace}
				onReplaceAll={onReplaceAll}
				onClose={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'Show replace' }));
		expect(onModeChange).toHaveBeenCalledWith('replace');

		cleanup();
		function ReplaceHarness() {
			const [replacement, setReplacement] = useState('draft');
			return (
				<NoteFind
					{...inert}
					mode="replace"
					query="plan"
					replacement={replacement}
					resultCount={2}
					currentIndex={0}
					onModeChange={onModeChange}
					onQueryChange={vi.fn()}
					onReplacementChange={(value) => {
						setReplacement(value);
						onReplacementChange(value);
					}}
					onNext={vi.fn()}
					onPrevious={vi.fn()}
					onReplace={onReplace}
					onReplaceAll={onReplaceAll}
					onClose={vi.fn()}
				/>
			);
		}
		render(<ReplaceHarness />);

		const replacement = screen.getByRole('textbox', { name: 'Replace with' });
		await user.clear(replacement);
		await user.type(replacement, 'final');
		expect(onReplacementChange).toHaveBeenLastCalledWith('final');
		await user.keyboard('{Enter}');
		expect(onReplace).toHaveBeenCalledOnce();
		await user.click(screen.getByRole('button', { name: 'Replace all' }));
		expect(onReplaceAll).toHaveBeenCalledOnce();
	});
});
