// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentComposer } from '@web/components/agent/agent-composer';
import type { AgentCatalog } from '@web/lib/agent-api';
import { AGENT_MAX_STEPS } from '@web/lib/agent-settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
			reasoning: { levels: ['off', 'on'], default: 'on' },
			temperature: null,
		},
		{
			id: 'minimax/minimax-m3',
			provider: 'novita',
			label: 'MiniMax M3',
			reasoning: { levels: ['off', 'adaptive'], default: 'adaptive' },
			temperature: null,
		},
	],
	tools: [
		{ name: 'tavily', description: 'Search the web' },
		{ name: 'calculator', description: 'Do arithmetic' },
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
		// The trigger announces its setting, not just its name: "Model: <label>".
		await userEvent.click(
			await screen.findByRole('button', { name: /^Model:/ }),
		);
		expect(await screen.findByText('Qwen3.7 Max')).toBeDefined();

		await userEvent.type(screen.getByPlaceholderText(/search models/i), 'qwen');
		expect(screen.getByText('Qwen3.7 Max')).toBeDefined();
		expect(screen.queryByText('MiniMax M3')).toBe(null);
	});

	it('searches the tool picker and keeps it open while toggling', async () => {
		const props = renderComposer();
		await openSettings();
		await userEvent.click(
			await screen.findByRole('button', {
				name: 'Tools for this conversation',
			}),
		);
		await userEvent.type(screen.getByPlaceholderText(/search tools/i), 'calc');
		expect(screen.queryByText('tavily')).toBe(null);

		await userEvent.click(screen.getByText('calculator'));
		expect(props.onSelectionChange).toHaveBeenCalledWith(
			expect.objectContaining({ tools: ['tavily', 'calculator'] }),
		);
	});

	/**
	 * Every step is a paid provider call, so the ceiling the API enforces is
	 * enforced here too: `max` alone only decorates a typed number, and a larger
	 * budget would come back as a 422.
	 */
	it('accepts a step count up to the ceiling and no further', async () => {
		const props = renderComposer();
		await openSettings();
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
	it('keeps only the settings trigger and send outside the surface', () => {
		mockViewport(true);
		renderComposer();
		const row = controlRow();
		expect(
			within(row)
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label')),
		).toEqual([expect.stringMatching(/^Generation settings/), 'Send message']);
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
			expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull();
			expect(
				screen.queryByRole('button', { name: 'Reasoning level' }),
			).toBeNull();
			expect(
				screen.queryByRole('button', { name: 'Tools for this conversation' }),
			).toBeNull();

			await openSettings();
			expect(
				await screen.findByRole('button', { name: /^Model:/ }),
			).toBeDefined();
			expect(
				screen.getByRole('button', { name: 'Reasoning level' }),
			).toBeDefined();
			expect(
				screen.getByRole('button', { name: 'Tools for this conversation' }),
			).toBeDefined();
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
				reasoning: { levels: ['off', 'low', 'high'], default: 'high' },
				temperature: null,
			},
		]);
		const row = controlRow();
		expect(within(row).getAllByRole('button')).toHaveLength(2);
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
