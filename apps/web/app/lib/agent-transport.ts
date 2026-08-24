import type { AgentSelection } from '@web/lib/agent';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { authenticatedFetch } from '@web/lib/authenticated-api';
import { env } from '@web/lib/env';
import { DefaultChatTransport } from 'ai';

/**
 * Pure and exported so the request contract is testable: only the last
 * message travels — the server owns the history — together with the thread id
 * and the selection of the turn. A regenerate arrives as the same user
 * message id, which is how the server knows to replace the stale tail.
 */
export function prepareAgentChatRequest({
	threadId,
	messages,
	selection,
}: {
	threadId: string;
	messages: readonly AgentUIMessage[];
	selection: AgentSelection;
}) {
	return {
		body: {
			threadId,
			model: selection.model,
			...(selection.reasoning === undefined
				? {}
				: { reasoning: selection.reasoning }),
			tools: selection.tools,
			maxSteps: selection.maxSteps,
			...(selection.temperature === undefined
				? {}
				: { temperature: selection.temperature }),
			message: messages.at(-1),
		},
	};
}

/**
 * The chat stream cannot travel through Eden — `useChat` drives a raw SSE
 * fetch — so the transport reuses `authenticatedFetch`, the same instance
 * treaty wraps, and the refresh dedupe stays single.
 *
 * `getSelection` is read at send time: changing the model between turns must
 * affect the next request without rebuilding the chat mid-stream.
 */
export function createAgentChatTransport(options: {
	threadId: string;
	getSelection: () => AgentSelection;
}) {
	return new DefaultChatTransport<AgentUIMessage>({
		api: `${env.VITE_API_URL}/agent/chat`,
		fetch: authenticatedFetch as typeof fetch,
		prepareSendMessagesRequest: ({ messages }) =>
			prepareAgentChatRequest({
				threadId: options.threadId,
				messages,
				selection: options.getSelection(),
			}),
	});
}
