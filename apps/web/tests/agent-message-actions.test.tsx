// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentMessageActions } from '@web/components/agent/agent-message-actions';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

describe('agent message actions', () => {
	it('fires the history-rewriting callbacks it was given', async () => {
		const onEdit = vi.fn();
		const onRetry = vi.fn();
		render(
			<AgentMessageActions text="hola" onEdit={onEdit} onRetry={onRetry} />,
		);

		await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
		expect(onEdit).toHaveBeenCalledTimes(1);
		await userEvent.click(
			screen.getByRole('button', { name: 'Retry from this message' }),
		);
		expect(onRetry).toHaveBeenCalledTimes(1);

		// A reply's action set was not passed, so it must not render.
		expect(
			screen.queryByRole('button', { name: 'Fork conversation here' }),
		).toBeNull();
	});

	it('offers forking only when the caller wired it', async () => {
		const onFork = vi.fn();
		render(<AgentMessageActions text="respuesta" onFork={onFork} />);

		await userEvent.click(
			screen.getByRole('button', { name: 'Fork conversation here' }),
		);
		expect(onFork).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
	});
});
