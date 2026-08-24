import type { AgentUIMessage } from '@web/lib/agent-api';
import { prepareAgentChatRequest } from '@web/lib/agent-transport';
import { describe, expect, it } from 'vitest';

const messages: AgentUIMessage[] = [
	{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'primer turno' }] },
	{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'respuesta' }] },
	{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'segundo turno' }] },
];

describe('prepareAgentChatRequest', () => {
	it('sends only the last message with the turn selection', () => {
		const { body } = prepareAgentChatRequest({
			threadId: 't1',
			messages,
			selection: {
				model: 'claude-sonnet-5',
				reasoning: 'low',
				tools: ['tavily'],
				maxSteps: 10,
				temperature: 0.7,
			},
		});
		expect(body).toEqual({
			threadId: 't1',
			model: 'claude-sonnet-5',
			reasoning: 'low',
			tools: ['tavily'],
			maxSteps: 10,
			temperature: 0.7,
			message: messages[2],
		});
	});

	it('omits reasoning for models without a knob', () => {
		const { body } = prepareAgentChatRequest({
			threadId: 't1',
			messages,
			selection: { model: 'qwen/qwen3.7-max', tools: [], maxSteps: 5 },
		});
		expect('reasoning' in body).toBe(false);
		expect('temperature' in body).toBe(false);
		expect(body.maxSteps).toBe(5);
	});

	it('reads the selection per request, not per chat', () => {
		const first = prepareAgentChatRequest({
			threadId: 't1',
			messages,
			selection: {
				model: 'claude-sonnet-5',
				reasoning: 'low',
				tools: [],
				maxSteps: 3,
			},
		});
		const second = prepareAgentChatRequest({
			threadId: 't1',
			messages,
			selection: {
				model: 'gpt-5.6-luna',
				reasoning: 'none',
				tools: ['tavily'],
				maxSteps: 20,
			},
		});
		expect(first.body).not.toEqual(second.body);
		expect((second.body as { model: string }).model).toBe('gpt-5.6-luna');
	});
});
