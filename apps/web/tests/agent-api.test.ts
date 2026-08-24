// @vitest-environment happy-dom

import {
	bulkDeleteThreads,
	compactThread,
	generateThreadTitle,
	listThreads,
} from '@web/lib/agent-api';
import { authenticatedApi } from '@web/lib/authenticated-api';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/authenticated-api', () => ({
	authenticatedApi: {
		agent: {
			threads: vi.fn(),
		},
	},
}));

describe('compactThread', () => {
	it('returns the exact marker created by the server', async () => {
		const message = {
			id: '00000000-0000-4000-8000-000000000099',
			role: 'assistant' as const,
			parts: [{ type: 'text' as const, text: 'summary' }],
			metadata: { kind: 'compaction' as const, model: 'test-model' },
		};
		vi.mocked(authenticatedApi.agent.threads).mockReturnValueOnce({
			compact: {
				post: vi.fn().mockResolvedValue({ status: 201, data: { message } }),
			},
		} as unknown as ReturnType<typeof authenticatedApi.agent.threads>);

		await expect(compactThread('thread-a', 'test-model')).resolves.toEqual(
			message,
		);
	});
});

describe('listThreads', () => {
	/**
	 * A tag stands for the index, so only the request that asks for the index
	 * carries one. A cursor or a search would be claiming freshness for a slice.
	 */
	it('sends the held tag for the default page and for nothing else', async () => {
		const get = vi.fn().mockResolvedValue({
			status: 200,
			data: { threads: [], nextCursor: null },
			response: { headers: new Headers() },
		});
		Object.assign(authenticatedApi.agent.threads, { get });

		await listThreads({ knownTag: 'W/"held"' });
		await listThreads({ knownTag: 'W/"held"', query: 'term' });
		await listThreads({
			knownTag: 'W/"held"',
			cursor: { updatedAt: 2, id: 'thread-a' },
		});

		expect(get.mock.calls[0]?.[0]).toMatchObject({
			fetch: { headers: { 'if-none-match': 'W/"held"' } },
		});
		expect(get.mock.calls[1]?.[0]).not.toHaveProperty('fetch');
		expect(get.mock.calls[2]?.[0]).not.toHaveProperty('fetch');
	});
});

describe('thread mutations', () => {
	it('generates a title with the current model as fallback', async () => {
		const updated = {
			id: 'thread-a',
			title: 'Generated title',
			createdAt: 1,
			updatedAt: 2,
		};
		vi.mocked(authenticatedApi.agent.threads).mockReturnValueOnce({
			title: {
				post: vi.fn().mockResolvedValue({ status: 200, data: updated }),
			},
		} as unknown as ReturnType<typeof authenticatedApi.agent.threads>);

		await expect(generateThreadTitle('thread-a', 'fallback')).resolves.toEqual(
			updated,
		);
	});

	it('deletes a batch in one request and returns the deleted ids', async () => {
		const post = vi
			.fn()
			.mockResolvedValue({ status: 200, data: { deleted: ['thread-a'] } });
		Object.assign(authenticatedApi.agent.threads, {
			bulk: { delete: { post } },
		});

		await expect(bulkDeleteThreads(['thread-a', 'thread-b'])).resolves.toEqual([
			'thread-a',
		]);
		expect(post).toHaveBeenCalledWith({ ids: ['thread-a', 'thread-b'] });
	});
});
