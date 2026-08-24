// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { AgentMessageParts } from '@web/components/agent/agent-message-parts';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { describe, expect, it } from 'vitest';

function assistant(parts: AgentUIMessage['parts']): AgentUIMessage {
	return { id: 'a1', role: 'assistant', parts };
}

describe('agent message parts', () => {
	it('shows the query while tavily searches and the sources when it lands', () => {
		const searching = render(
			<AgentMessageParts
				isStreaming
				message={assistant([
					{
						type: 'tool-tavily',
						toolCallId: 'call-1',
						state: 'input-available',
						input: { query: 'bun runtime' },
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(searching.getByText(/Searching: bun runtime/)).toBeDefined();
		searching.unmount();

		render(
			<AgentMessageParts
				isStreaming={false}
				message={assistant([
					{
						type: 'tool-tavily',
						toolCallId: 'call-1',
						state: 'output-available',
						input: { query: 'bun runtime' },
						output: {
							query: 'bun runtime',
							results: [
								{ title: 'Bun', url: 'https://bun.sh', content: '', score: 1 },
							],
						},
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(screen.getByText('1 source')).toBeDefined();
	});

	it('reports a failed search inline instead of dropping it', () => {
		render(
			<AgentMessageParts
				isStreaming={false}
				message={assistant([
					{
						type: 'tool-tavily',
						toolCallId: 'call-1',
						state: 'output-error',
						input: { query: 'bun' },
						errorText: 'rate limited',
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(screen.getByText(/rate limited/)).toBeDefined();
	});

	it('renders user text verbatim, never as markdown', () => {
		render(
			<AgentMessageParts
				isStreaming={false}
				message={{
					id: 'u1',
					role: 'user',
					parts: [{ type: 'text', text: '**not bold**' }],
				}}
			/>,
		);
		expect(screen.getByText('**not bold**')).toBeDefined();
	});
});
