import { type AgentSelection, messageText } from '@web/lib/agent';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { toolsForTurn } from '@web/lib/agent-mentions';
import { authenticatedFetch } from '@web/lib/authenticated-api';
import { env } from '@web/lib/env';
import { DefaultChatTransport } from 'ai';

/**
 * Pure and exported so the request contract is testable: only the last
 * message travels — the server owns the history — together with the thread id
 * and the selection of the turn. A regenerate arrives as the same user
 * message id, which is how the server knows to replace the stale tail.
 *
 * The tools are widened per turn: a message that mentions files must be able
 * to read them whatever the saved selection says, and doing it here covers
 * submit, edit, retry and regenerate alike — they all pass through this body.
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
	const message = messages.at(-1);
	return {
		body: {
			threadId,
			model: selection.model,
			...(selection.reasoning === undefined
				? {}
				: { reasoning: selection.reasoning }),
			tools: toolsForTurn(selection.tools, messageText(message?.parts ?? [])),
			maxSteps: selection.maxSteps,
			...(selection.temperature === undefined
				? {}
				: { temperature: selection.temperature }),
			message,
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
