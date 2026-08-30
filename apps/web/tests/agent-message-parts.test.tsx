// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import { AgentMessageParts } from '@web/components/agent/agent-message-parts';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

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

	it('renders a file mention as a chip with the stored name', () => {
		render(
			<AgentMessageParts
				isStreaming={false}
				message={{
					id: 'u1',
					role: 'user',
					parts: [{ type: 'text', text: `look at @f:${FILE_ID} please` }],
				}}
			/>,
		);
		expect(screen.getByText('report.pdf')).toBeDefined();
		expect(screen.queryByText(new RegExp(FILE_ID))).toBeNull();
	});

	it('leaves an unknown mention as its raw token', () => {
		const unknown = '0198c9a2-2222-7000-8000-abcdefabcdef';
		render(
			<AgentMessageParts
				isStreaming={false}
				message={{
					id: 'u1',
					role: 'user',
					parts: [{ type: 'text', text: `@f:${unknown}` }],
				}}
			/>,
		);
		expect(screen.getByText(`@f:${unknown}`)).toBeDefined();
	});

	it('shows the storage search lifecycle', () => {
		const searching = render(
			<AgentMessageParts
				isStreaming
				message={assistant([
					{
						type: 'tool-storageSearch',
						toolCallId: 'call-1',
						state: 'input-available',
						input: { query: 'invoice' },
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(searching.getByText(/Searching files: invoice/)).toBeDefined();
		searching.unmount();

		render(
			<AgentMessageParts
				isStreaming={false}
				message={assistant([
					{
						type: 'tool-storageSearch',
						toolCallId: 'call-1',
						state: 'output-available',
						input: { query: 'invoice' },
						output: {
							files: [
								{
									fileId: FILE_ID,
									name: 'invoice.pdf',
									folder: null,
									mediaType: 'application/pdf',
									size: 10,
									createdAt: 0,
								},
							],
							hasMore: false,
						},
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(screen.getByText(/invoice\.pdf/)).toBeDefined();
	});

	it('shows the storage read lifecycle and its failure', () => {
		const reading = render(
			<AgentMessageParts
				isStreaming
				message={assistant([
					{
						type: 'tool-storageRead',
						toolCallId: 'call-1',
						state: 'input-available',
						input: { fileId: FILE_ID },
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(reading.getByText(/Reading file/)).toBeDefined();
		reading.unmount();

		const done = render(
			<AgentMessageParts
				isStreaming={false}
				message={assistant([
					{
						type: 'tool-storageRead',
						toolCallId: 'call-1',
						state: 'output-available',
						input: { fileId: FILE_ID },
						output: {
							fileId: FILE_ID,
							name: 'report.pdf',
							mediaType: 'application/pdf',
							size: 1234,
							kind: 'pdf',
							converted: false,
						},
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(done.getByText('report.pdf')).toBeDefined();
		done.unmount();

		render(
			<AgentMessageParts
				isStreaming={false}
				message={assistant([
					{
						type: 'tool-storageRead',
						toolCallId: 'call-1',
						state: 'output-error',
						input: { fileId: FILE_ID },
						errorText: 'File not found',
					} as AgentUIMessage['parts'][number],
				])}
			/>,
		);
		expect(screen.getByText(/File not found/)).toBeDefined();
	});
});
