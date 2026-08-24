import { conditionalGet } from '@web/lib/http-conditional';
import { describe, expect, it, vi } from 'vitest';

/**
 * The client half of the exchange, exercised with a fake reply: no store, no
 * contract and no network, so what is left under test is only the protocol —
 * which header goes out, what a 304 means, and where the next tag comes from.
 */
function reply(status: number, data: unknown, etag?: string) {
	return {
		status,
		data,
		response: { headers: new Headers(etag ? { etag } : {}) },
	};
}

describe('conditionalGet', () => {
	it('sends the tag it holds and returns the next one alongside the value', async () => {
		const send = vi.fn(async () => reply(200, ['row'], 'W/"next"'));

		await expect(
			conditionalGet('W/"held"', send, (answer) => ({
				rows: answer.data as string[],
			})),
		).resolves.toEqual({ rows: ['row'], tag: 'W/"next"' });
		expect(send).toHaveBeenCalledWith({
			fetch: { headers: { 'if-none-match': 'W/"held"' } },
		});
	});

	it('asks unconditionally when it holds no tag', async () => {
		const send = vi.fn(async () => reply(200, [], 'W/"first"'));

		await conditionalGet(undefined, send, () => ({ rows: [] }));

		expect(send).toHaveBeenCalledWith({});
	});

	it('reports a 304 as unchanged without consulting the contract', async () => {
		const accept = vi.fn();
		const send = vi.fn(async () => reply(304, null));

		await expect(conditionalGet('W/"held"', send, accept)).resolves.toBe(
			'unchanged',
		);
		expect(accept).not.toHaveBeenCalled();
	});

	it('leaves the tag unset when the response carries none', async () => {
		const send = vi.fn(async () => reply(200, []));

		await expect(
			conditionalGet(undefined, send, () => ({ rows: [] })),
		).resolves.toEqual({ rows: [], tag: undefined });
	});

	it("raises the caller's own failure rather than one of its own", async () => {
		class OwnApiError extends Error {}
		const send = vi.fn(async () => reply(500, null));

		await expect(
			conditionalGet(undefined, send, () => {
				throw new OwnApiError('mine');
			}),
		).rejects.toBeInstanceOf(OwnApiError);
	});
});
