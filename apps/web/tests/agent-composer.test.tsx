// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentComposer } from '@web/components/agent/agent-composer';
import type { AgentCatalog } from '@web/lib/agent-api';
import { AGENT_MAX_STEPS } from '@web/lib/agent-settings';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FILE_ID = '0198c9a2-1111-7000-8000-abcdefabcdef';

const storageState = {
	files: [
		{
			id: FILE_ID,
			name: 'report.pdf',
			path: 'Agent',
			contentType: 'application/pdf',
			size: 1234,
			isPublic: false,
			viewCount: 0,
			uploadedFromNotes: false,
			createdAt: 0,
			updatedAt: 0,
		},
	],
	status: 'ready' as const,
	load: vi.fn(async () => 'loaded'),
};

vi.mock('@web/lib/storage-store', () => ({
	useStorageStore: (selector: (state: typeof storageState) => unknown) =>
		selector(storageState),
}));

const uploadStoredFiles = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/storage-file-upload', () => ({ uploadStoredFiles }));

vi.mock('@web/lib/storage-api', () => ({
	storageTransport: {},
	getFileLink: vi.fn(async () => 'https://example.test/link'),
}));

beforeEach(() => {
	uploadStoredFiles.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const catalog: AgentCatalog = {
	models: [
		{
			id: 'claude-sonnet-5',
			provider: 'anthropic',
			label: 'Claude Sonnet 5',
			attachments: { image: true, pdf: true },
			reasoning: { levels: ['off', 'low', 'high'], default: 'high' },
			temperature: {
				min: 0,
				max: 1,
				step: 0.1,
				default: 0.5,
				reasoning: ['off', 'low'],
			},
		},
		{
			id: 'qwen/qwen3.8-max',
			provider: 'novita',
			label: 'Qwen3.7 Max',
			attachments: { image: false, pdf: false },
			reasoning: { levels: ['off', 'on'], default: 'on' },
			temperature: null,
		},
		{
			id: 'minimax/minimax-m3',
			provider: 'novita',
			label: 'MiniMax M3',
			attachments: { image: true, pdf: false },
			reasoning: { levels: ['off', 'adaptive'], default: 'adaptive' },
			temperature: null,
		},
	],
	tools: [
		{ name: 'tavily', group: 'Web', description: 'Search the web' },
		{ name: 'calculator', group: 'Math', description: 'Do arithmetic' },
		{ name: 'storageRead', group: 'Storage', description: 'Read stored files' },
	],
};

function renderComposer(model = 'claude-sonnet-5', models = catalog.models) {
	const props: React.ComponentProps<typeof AgentComposer> = {
		value: '',
		status: 'ready' as const,
		catalog: { ...catalog, models },
		selection: {
			model,
			reasoning: model === 'claude-sonnet-5' ? 'high' : 'on',
			tools: ['tavily'],
			maxSteps: 5,
		},
		onChange: vi.fn(),
		onSelectionChange: vi.fn(),
		onSubmit: vi.fn(),
		onStop: vi.fn(),
	};
	render(<AgentComposer {...props} />);
	return props;
}

/**
 * Every per-turn control lives behind one trigger now, so a test that wants to
 * reach a picker or a numeric input opens that surface first.
 */
async function openSettings() {
	await userEvent.click(
		screen.getByRole('button', { name: /^Generation settings/ }),
	);
}

/** The other half of the split: what the turn may use while it answers. */
async function openTools() {
	await userEvent.click(
		screen.getByRole('button', { name: /^Tools and steps/ }),
	);
}

/** The composer keeps no breakpoint state of its own; this pins the viewport
 * only so the assertions can say which width they are talking about. */
function mockViewport(mobile: boolean) {
	vi.spyOn(window, 'matchMedia').mockImplementation(
		(query) =>
			({
				matches: mobile && query.includes('max-width: 639px'),
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}) as MediaQueryList,
	);
}

/** The row that stays outside the surface: the trigger and send, nothing else. */
function controlRow() {
	const send = screen.getByRole('button', {
		name: /^(Send message|Stop generating|Preparing message)$/,
	});
	const row = send.parentElement;
	if (!row) throw new Error('composer control row missing');
	return row;
}

/**
 * Regression: every `DropdownMenuLabel` is a Base UI `Menu.GroupLabel` and
 * throws render-time if it is not inside a `Menu.Group`/`Menu.RadioGroup` —
 * opening the reasoning menu crashed the whole screen.
 */
describe('the composer controls', () => {
	it('opens the reasoning menu with the levels of the chosen model', async () => {
		const props = renderComposer();
		await openSettings();
		await userEvent.click(
			await screen.findByRole('button', { name: 'Reasoning level' }),
		);
		expect(await screen.findByText('off')).toBeDefined();
		expect(screen.getByText('low')).toBeDefined();

		await userEvent.click(screen.getByRole('menuitemradio', { name: 'low' }));
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			expect.objectContaining({ reasoning: 'low' }),
		);
		expect(screen.queryByRole('menu', { name: 'Reasoning level' })).toBeNull();
	});

	/**
	 * Novita models do have a reasoning knob — their own vocabulary, not
	 * Anthropic's — so the selector has to appear for them too.
	 */
	it('offers reasoning for a novita model in its own vocabulary', async () => {
		renderComposer('minimax/minimax-m3');
		await openSettings();
		await userEvent.click(
			await screen.findByRole('button', { name: 'Reasoning level' }),
		);
		expect(await screen.findByText('adaptive')).toBeDefined();
	});

	it('searches the model picker instead of listing everything', async () => {
		renderComposer();
		await openSettings();
		expect(await screen.findByText('Qwen3.7 Max')).toBeDefined();

		await userEvent.type(screen.getByPlaceholderText(/search models/i), 'qwen');
		expect(screen.getByText('Qwen3.7 Max')).toBeDefined();
		expect(screen.queryByText('MiniMax M3')).toBe(null);
	});

	/**
	 * The provider rail is the second axis of the same list. It also has to
	 * yield to a query it no longer matches: a filter still pointing at
	 * Anthropic while the only match is a Novita model would answer "nothing
	 * matches" with the row one click away.
	 */
	it('filters the model list by provider and yields to the search', async () => {
		renderComposer();
		await openSettings();
		await userEvent.click(
			await screen.findByRole('button', { name: /^Anthropic/ }),
		);
		expect(screen.queryByText('Qwen3.7 Max')).toBe(null);

		await userEvent.type(screen.getByPlaceholderText(/search models/i), 'qwen');
		expect(await screen.findByText('Qwen3.7 Max')).toBeDefined();
	});

	/**
	 * A model that cannot be sent bytes says so where it is chosen, and the two
	 * flags are independent: the badge is a glyph, so what it means has to be
	 * readable — by a screen reader and on hover — not inferred from an eye.
	 */
	it('badges what each model can actually be shown', async () => {
		renderComposer();
		await openSettings();
		const rows = await screen.findAllByRole('option');
		const claude = rows.find((row) => row.textContent?.includes('Claude'));
		const qwen = rows.find((row) => row.textContent?.includes('Qwen'));
		const minimax = rows.find((row) => row.textContent?.includes('MiniMax'));
		expect(claude?.textContent).toContain('Reads images and PDFs');
		expect(minimax?.textContent).toContain('Reads images');
		expect(minimax?.textContent).not.toContain('PDFs');
		expect(qwen?.textContent).not.toContain('Reads');
	});

	it('searches the tool picker and keeps it open while toggling', async () => {
		const props = renderComposer();
		await openTools();
		await userEvent.type(
			await screen.findByPlaceholderText(/search tools/i),
			'calc',
		);
		expect(screen.queryByText('tavily')).toBe(null);

		await userEvent.click(screen.getByText('calculator'));
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			expect.objectContaining({ tools: ['tavily', 'calculator'] }),
		);
		expect(screen.getByPlaceholderText(/search tools/i)).toBeDefined();
	});

	/**
	 * Every step is a paid provider call, so the ceiling the API enforces is
	 * enforced here too: `max` alone only decorates a typed number, and a larger
	 * budget would come back as a 422.
	 */
	it('accepts a step count up to the ceiling and no further', async () => {
		const props = renderComposer();
		await openTools();
		const steps = await screen.findByRole('spinbutton', {
			name: 'Maximum steps',
		});
		expect(steps).toHaveProperty('min', '1');
		expect(steps).toHaveProperty('max', String(AGENT_MAX_STEPS));

		await userEvent.clear(steps);
		await userEvent.type(steps, String(AGENT_MAX_STEPS));
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			expect.objectContaining({ maxSteps: AGENT_MAX_STEPS }),
		);

		await userEvent.clear(steps);
		await userEvent.type(steps, String(AGENT_MAX_STEPS + 1));
		expect(props.onSelectionChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ maxSteps: AGENT_MAX_STEPS + 1 }),
		);
	});

	it('accepts a typed temperature and clearing it restores provider default', async () => {
		const props = renderComposer();
		await openSettings();
		await userEvent.click(
			await screen.findByRole('button', { name: 'Reasoning level' }),
		);
		await userEvent.click(
			await screen.findByRole('menuitemradio', { name: 'low' }),
		);
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			expect.objectContaining({ reasoning: 'low' }),
		);

		cleanup();
		const supported = renderComposer();
		supported.selection.reasoning = 'low';
		cleanup();
		render(<AgentComposer {...supported} />);
		await openSettings();
		const temperature = await screen.findByRole('spinbutton', {
			name: 'Temperature',
		});
		expect(temperature).toHaveProperty('placeholder', 'Default');
		await userEvent.type(temperature, '0.5');
		expect(supported.onSelectionChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ temperature: 0.5 }),
		);

		cleanup();
		supported.selection = { ...supported.selection, temperature: 0.5 };
		render(<AgentComposer {...supported} />);
		await openSettings();
		await userEvent.clear(
			await screen.findByRole('spinbutton', { name: 'Temperature' }),
		);
		expect(supported.onSelectionChange).toHaveBeenLastCalledWith(
			expect.not.objectContaining({ temperature: expect.anything() }),
		);

		cleanup();
		renderComposer();
		await openSettings();
		expect(
			screen.queryByRole('spinbutton', { name: 'Temperature' }),
		).toBeNull();
	});

	it('shows a disabled pending affordance before useChat starts the request', () => {
		const props = {
			...renderComposer(),
			busy: true,
		};
		cleanup();
		render(<AgentComposer {...props} />);
		expect(
			screen.queryByRole('button', { name: 'Stop generating' }),
		).toBeNull();
		expect(
			screen
				.getByRole('button', { name: 'Preparing message' })
				.hasAttribute('disabled'),
		).toBe(true);
	});

	/**
	 * Replaces an older test that asserted the row carried `flex-wrap`: with the
	 * turn's selection behind one trigger the row has a fixed composition, so
	 * what matters is that nothing else got into it and send stays right there.
	 */
	it('keeps only the icon affordances outside the surface', () => {
		mockViewport(true);
		renderComposer();
		const row = controlRow();
		expect(
			within(row)
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label')),
		).toEqual([
			expect.stringMatching(/^Generation settings/),
			expect.stringMatching(/^Tools and steps/),
			'Attach files',
			'Send message',
		]);
		expect(within(row).queryAllByRole('spinbutton')).toHaveLength(0);
		expect(within(row).queryAllByRole('combobox')).toHaveLength(0);
	});

	/**
	 * One surface at every width: the pickers and the numeric inputs are behind
	 * the trigger on a phone and on a desktop alike, so no breakpoint change can
	 * leave a control — or a backdrop — half mounted.
	 */
	it('keeps every per-turn control behind the surface at both widths', async () => {
		for (const mobile of [true, false]) {
			mockViewport(mobile);
			renderComposer();
			expect(screen.queryByRole('spinbutton')).toBeNull();
			expect(screen.queryByPlaceholderText(/search models/i)).toBeNull();
			expect(
				screen.queryByRole('button', { name: 'Reasoning level' }),
			).toBeNull();
			expect(screen.queryByPlaceholderText(/search tools/i)).toBeNull();

			await openSettings();
			expect(
				await screen.findByPlaceholderText(/search models/i),
			).toBeDefined();
			expect(
				screen.getByRole('button', { name: 'Reasoning level' }),
			).toBeDefined();
			await userEvent.keyboard('{Escape}');

			await openTools();
			expect(await screen.findByPlaceholderText(/search tools/i)).toBeDefined();
			expect(
				screen.getByRole('spinbutton', { name: 'Maximum steps' }),
			).toBeDefined();
			cleanup();
		}
	});

	/**
	 * The point of the collapse: the row's width no longer depends on any
	 * registry. A model label is the longest text the selection can produce, and
	 * however long it gets it stays inside the surface and in the trigger's
	 * accessible name — never as text in the row.
	 */
	it('keeps the row bounded however long the model label is', async () => {
		const longLabel = `Claude ${'Extremely Verbose '.repeat(20)}Model`;
		renderComposer('claude-sonnet-5', [
			{
				id: 'claude-sonnet-5',
				provider: 'anthropic',
				label: longLabel,
				attachments: { image: true, pdf: true },
				reasoning: { levels: ['off', 'low', 'high'], default: 'high' },
				temperature: null,
			},
		]);
		const row = controlRow();
		expect(within(row).getAllByRole('button')).toHaveLength(4);
		expect(row.textContent).not.toContain('Extremely Verbose');
		expect(screen.queryByText(longLabel)).toBeNull();

		const trigger = within(row).getByRole('button', {
			name: /^Generation settings/,
		});
		expect(trigger.getAttribute('aria-label')).toContain(longLabel);

		await userEvent.click(trigger);
		expect(await screen.findByText(longLabel)).toBeDefined();
	});
});

/**
 * The composer is controlled; these tests wire value/onChange to real state so
 * typing accumulates the way it does on screen.
 */
function StatefulComposer(props: { onSubmit?: () => void }) {
	const [value, setValue] = useState('');
	return (
		<AgentComposer
			value={value}
			status="ready"
			catalog={catalog}
			selection={{
				model: 'claude-sonnet-5',
				reasoning: 'high',
				tools: [],
				maxSteps: 5,
			}}
			onChange={setValue}
			onSelectionChange={() => {}}
			onSubmit={props.onSubmit ?? (() => {})}
			onStop={() => {}}
		/>
	);
}

describe('file mentions', () => {
	it('typing @ opens the namespace list with Notes disabled', async () => {
		render(<StatefulComposer />);
		await userEvent.type(screen.getByRole('textbox'), '@');
		const list = await screen.findByRole('listbox', { name: 'Mention' });
		expect(within(list).getByText('Files')).toBeDefined();
		const notes = within(list).getByText(/Notes/);
		expect(notes.closest('[aria-disabled="true"]')).not.toBeNull();
	});

	it('picking Files completes the namespace and searching inserts the token', async () => {
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		await userEvent.type(textbox, '@');
		await userEvent.click(await screen.findByText('Files'));
		expect(textbox.value).toBe('@f:');

		await userEvent.type(textbox, 'rep');
		const option = await screen.findByText('report.pdf');
		await userEvent.click(option);
		expect(textbox.value).toBe(`@f:${FILE_ID} `);
	});

	it('typing @f: and pressing Enter selects without submitting', async () => {
		const onSubmit = vi.fn();
		render(<StatefulComposer onSubmit={onSubmit} />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		await userEvent.type(textbox, '@f:rep');
		await screen.findByText('report.pdf');
		await userEvent.keyboard('{Enter}');
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textbox.value).toBe(`@f:${FILE_ID} `);
	});

	it('Escape dismisses the list until a new trigger', async () => {
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox');
		await userEvent.type(textbox, '@');
		await screen.findByRole('listbox', { name: 'Mention' });
		await userEvent.keyboard('{Escape}');
		expect(screen.queryByRole('listbox', { name: 'Mention' })).toBeNull();
	});
});

describe('mention chips', () => {
	it('shows the mentioned file as a chip and removing it strips the token', async () => {
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		await userEvent.type(textbox, '@f:rep');
		await userEvent.click(await screen.findByText('report.pdf'));
		expect(textbox.value).toBe(`@f:${FILE_ID} `);

		// The chip names what the raw token only points at, with a preview.
		expect(
			screen.getByRole('button', { name: 'Preview report.pdf' }),
		).toBeDefined();

		await userEvent.click(
			screen.getByRole('button', { name: 'Remove report.pdf' }),
		);
		expect(textbox.value).toBe('');
		expect(
			screen.queryByRole('button', { name: 'Remove report.pdf' }),
		).toBeNull();
	});

	it('forces the read tool visibly while the draft mentions a file', async () => {
		render(<StatefulComposer />);
		await userEvent.type(screen.getByRole('textbox'), '@f:rep');
		await userEvent.click(await screen.findByText('report.pdf'));

		await openTools();
		const option = (await screen.findByText('storageRead')).closest(
			'[role="option"]',
		);
		if (!option) throw new Error('storageRead option missing');
		expect(option.getAttribute('aria-checked')).toBe('true');
		expect(option.getAttribute('data-forced')).toBe('true');
		expect(screen.getByText('Auto — file mentioned')).toBeDefined();
	});
});

describe('attachments', () => {
	it('uploads through the paperclip and appends a mention per file', async () => {
		uploadStoredFiles.mockResolvedValue([{ id: FILE_ID, name: 'photo.png' }]);
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		await userEvent.type(textbox, 'look at this');

		const input = screen.getByLabelText('Attach files (file input)');
		await userEvent.upload(
			input,
			new File(['x'], 'photo.png', { type: 'image/png' }),
		);

		expect(uploadStoredFiles).toHaveBeenCalledWith(
			[expect.any(File)],
			{ folder: 'Agent' },
			expect.any(Function),
		);
		expect(textbox.value).toBe(`look at this @f:${FILE_ID} `);
	});

	it('reports an upload that failed without touching the draft', async () => {
		uploadStoredFiles.mockRejectedValue(new Error('offline'));
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		await userEvent.type(textbox, 'draft');

		const input = screen.getByLabelText('Attach files (file input)');
		await userEvent.upload(
			input,
			new File(['x'], 'photo.png', { type: 'image/png' }),
		);

		expect(await screen.findByRole('alert')).toBeDefined();
		expect(textbox.value).toBe('draft');
	});

	it('routes a drop on the field to the same upload path', async () => {
		uploadStoredFiles.mockResolvedValue([{ id: FILE_ID, name: 'a.png' }]);
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
		const field = textbox.closest('div');
		if (!field) throw new Error('field container missing');

		fireEvent.drop(field, {
			dataTransfer: {
				types: ['Files'],
				files: [new File(['x'], 'a.png', { type: 'image/png' })],
			},
		});

		await vi.waitFor(() => expect(uploadStoredFiles).toHaveBeenCalled());
	});

	it('routes pasted files to the same upload path', async () => {
		uploadStoredFiles.mockResolvedValue([{ id: FILE_ID, name: 'a.png' }]);
		render(<StatefulComposer />);
		const textbox = screen.getByRole('textbox');

		fireEvent.paste(textbox, {
			clipboardData: {
				files: [new File(['x'], 'a.png', { type: 'image/png' })],
				getData: () => '',
			},
		});

		await vi.waitFor(() => expect(uploadStoredFiles).toHaveBeenCalled());
	});
});
