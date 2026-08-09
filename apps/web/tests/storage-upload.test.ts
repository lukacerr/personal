import {
	createUploadQueue,
	type UploadReservation,
	type UploadTransport,
} from '@web/lib/storage-upload';
import { describe, expect, it, vi } from 'vitest';

const MIB = 1024 * 1024;

function blob(size: number, type = 'application/octet-stream') {
	return new Blob([new Uint8Array(size)], { type });
}

function candidate(name: string, size: number, path: string | null = 'work') {
	return {
		id: `id-${name}`,
		name,
		path,
		contentType: 'application/octet-stream',
		body: blob(size),
		size,
	};
}

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type FakeOptions = {
	partSize?: number;
	/** Gives the test control over when each PUT settles. */
	gate?: (url: string) => Deferred<{ etag: string }> | undefined;
	failParts?: (url: string, attempt: number) => boolean;
	completeError?: unknown;
};

function fakeTransport(options: FakeOptions = {}) {
	const partSize = options.partSize ?? 8 * MIB;
	const calls: string[] = [];
	const inFlight = { current: 0, peak: 0 };
	/** Files with a transfer actually running, which is what concurrency bounds. */
	const active = new Set<string>();
	const filesUploading = { peak: 0 };
	const attempts = new Map<string, number>();
	const cancelled: string[] = [];

	const transport: UploadTransport = {
		async reserve(requests) {
			calls.push('reserve');
			return requests.map<UploadReservation>((request) => {
				const partCount = Math.ceil(request.size / partSize);
				return request.size <= partSize
					? {
							id: request.id,
							status: 'ready',
							mode: 'single',
							partSize,
							partCount: 1,
							url: `put://${request.id}`,
						}
					: {
							id: request.id,
							status: 'ready',
							mode: 'multipart',
							partSize,
							partCount,
						};
			});
		},
		async signParts(id, partNumbers) {
			calls.push(`signParts:${partNumbers.length}`);
			return partNumbers.map((partNumber) => ({
				partNumber,
				url: `put://${id}/${partNumber}`,
			}));
		},
		async put(url, _body, put) {
			const attempt = (attempts.get(url) ?? 0) + 1;
			attempts.set(url, attempt);
			inFlight.current += 1;
			inFlight.peak = Math.max(inFlight.peak, inFlight.current);
			// The id is the stable prefix of every URL belonging to one file.
			active.add(url.replace('put://', '').split('/')[0] ?? url);
			filesUploading.peak = Math.max(filesUploading.peak, active.size);
			try {
				const gate = options.gate?.(url);
				if (gate) await gate.promise;
				if (options.failParts?.(url, attempt))
					throw new Error('Network hiccup');
				put.onProgress?.(1);
				return { etag: `"etag-${url}"` };
			} finally {
				inFlight.current -= 1;
				active.delete(url.replace('put://', '').split('/')[0] ?? url);
			}
		},
		async complete(id) {
			calls.push('complete');
			if (options.completeError) throw options.completeError;
			return { id } as never;
		},
		async cancel(id) {
			cancelled.push(id);
		},
	};

	return { transport, calls, inFlight, filesUploading, cancelled, attempts };
}

function queue(
	fake: ReturnType<typeof fakeTransport>,
	overrides: Partial<Parameters<typeof createUploadQueue>[0]> = {},
) {
	return createUploadQueue({
		transport: fake.transport,
		// Tests must not wait out a real backoff.
		delay: async () => undefined,
		...overrides,
	});
}

describe('Upload queue', () => {
	it('uploads a small file with a single PUT', async () => {
		const fake = fakeTransport();
		const uploads = queue(fake);

		await uploads.enqueue([candidate('small.bin', 1024)]);

		expect(fake.calls).toEqual(['reserve', 'complete']);
		expect(uploads.items()[0]).toMatchObject({
			status: 'completed',
			progress: 1,
		});
	});

	it('splits a large file into parts and reassembles the etags in order', async () => {
		const fake = fakeTransport({ partSize: 4 * MIB });
		const uploads = queue(fake);

		await uploads.enqueue([candidate('big.bin', 10 * MIB)]);

		// Three parts signed in one batch, then a single completion.
		expect(fake.calls).toEqual(['reserve', 'signParts:3', 'complete']);
		expect(uploads.items()[0]?.status).toBe('completed');
	});

	it('asks for part URLs in batches instead of all at once', async () => {
		// A 5 TiB upload has ten thousand parts; signing them all up front would
		// be megabytes of JSON and signatures stale before they are used.
		const fake = fakeTransport({ partSize: 1 * MIB });
		const uploads = queue(fake, { partBatchSize: 4 });

		await uploads.enqueue([candidate('huge.bin', 10 * MIB)]);

		expect(fake.calls.filter((call) => call.startsWith('signParts'))).toEqual([
			'signParts:4',
			'signParts:4',
			'signParts:2',
		]);
	});

	it('never has more parts in flight than the configured limit', async () => {
		const gates = new Map<string, Deferred<{ etag: string }>>();
		const fake = fakeTransport({
			partSize: 1 * MIB,
			gate: (url) => {
				if (!gates.has(url)) gates.set(url, deferred());
				return gates.get(url);
			},
		});
		const uploads = queue(fake, { partConcurrency: 4, partBatchSize: 50 });

		const running = uploads.enqueue([candidate('wide.bin', 20 * MIB)]);
		// Four parts start together and the twentieth waits its turn.
		await vi.waitFor(() => expect(gates.size).toBe(4));
		expect(fake.inFlight.peak).toBe(4);

		while (gates.size < 20) {
			for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
			await vi.waitFor(() => expect(fake.inFlight.current).toBeGreaterThan(0));
		}
		for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
		await running;

		expect(fake.inFlight.peak).toBe(4);
		expect(uploads.items()[0]?.status).toBe('completed');
	});

	/**
	 * An unbounded pool with six large files opens dozens of simultaneous
	 * transfers that compete for the same bandwidth and all finish later.
	 */
	it('never uploads more files at once than the configured limit', async () => {
		const gates = new Map<string, Deferred<{ etag: string }>>();
		const fake = fakeTransport({
			gate: (url) => {
				if (!gates.has(url)) gates.set(url, deferred());
				return gates.get(url);
			},
		});
		const uploads = queue(fake, { fileConcurrency: 3 });

		const running = uploads.enqueue(
			Array.from({ length: 7 }, (_, index) =>
				candidate(`file-${index}.bin`, 1024),
			),
		);
		// Three transfers start; the remaining four wait for a free slot.
		await vi.waitFor(() => expect(gates.size).toBe(3));
		expect(fake.filesUploading.peak).toBe(3);

		for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
		await vi.waitFor(() => expect(gates.size).toBe(6));
		for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
		await vi.waitFor(() => expect(gates.size).toBe(7));
		for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
		await running;

		expect(fake.filesUploading.peak).toBe(3);
		expect(uploads.items().every((item) => item.status === 'completed')).toBe(
			true,
		);
	});

	it('retries a failed part and still finishes the upload', async () => {
		const fake = fakeTransport({
			partSize: 4 * MIB,
			failParts: (url, attempt) => url.endsWith('/2') && attempt === 1,
		});
		const uploads = queue(fake);

		await uploads.enqueue([candidate('flaky.bin', 8 * MIB)]);

		expect(uploads.items()[0]?.status).toBe('completed');
		expect(fake.attempts.get('put://id-flaky.bin/2')).toBe(2);
	});

	/**
	 * One lost part in a file of two hundred cannot take the whole upload down,
	 * and one dead file cannot take the rest of the batch down either.
	 */
	it('fails only the file whose part never succeeds', async () => {
		const fake = fakeTransport({
			failParts: (url) => url.includes('doomed'),
		});
		const uploads = queue(fake, { maxAttempts: 3 });

		await uploads.enqueue([
			candidate('fine.bin', 1024),
			candidate('doomed.bin', 1024),
			candidate('also-fine.bin', 1024),
		]);

		expect(uploads.items().map((item) => [item.name, item.status])).toEqual([
			['fine.bin', 'completed'],
			['doomed.bin', 'failed'],
			['also-fine.bin', 'completed'],
		]);
		expect(fake.attempts.get('put://id-doomed.bin')).toBe(3);
	});

	it('releases the reservation of a file it gave up on', async () => {
		const fake = fakeTransport({ failParts: () => true });
		const uploads = queue(fake, { maxAttempts: 1 });

		await uploads.enqueue([candidate('lost.bin', 1024)]);

		// Otherwise the name stays held until its reservation expires.
		expect(fake.cancelled).toEqual(['id-lost.bin']);
	});

	it('keeps a rejected reservation out of the transfer entirely', async () => {
		const fake = fakeTransport();
		fake.transport.reserve = async (requests) => {
			fake.calls.push('reserve');
			return requests.map((request) => ({
				id: request.id,
				status: 'rejected' as const,
				error: 'NAME_TAKEN',
			}));
		};
		const uploads = queue(fake);

		await uploads.enqueue([candidate('taken.bin', 1024)]);

		expect(uploads.items()[0]).toMatchObject({
			status: 'failed',
			error: 'A file with this name already exists in this folder.',
		});
		// A rejected name never becomes a transfer.
		expect(fake.calls).toEqual(['reserve']);
		expect(fake.attempts.size).toBe(0);
	});

	it('reports an expired upload as its own cause', async () => {
		const fake = fakeTransport({
			completeError: Object.assign(new Error('gone'), { status: 410 }),
		});
		const uploads = queue(fake);

		await uploads.enqueue([candidate('slow.bin', 1024)]);

		// A generic failure message would leave the user with no idea that
		// retrying is exactly what will work.
		expect(uploads.items()[0]?.error).toBe(
			'This upload took too long and expired. Try again.',
		);
	});

	it('cancels an upload in flight and releases its reservation', async () => {
		const gates = new Map<string, Deferred<{ etag: string }>>();
		const fake = fakeTransport({
			gate: (url) => {
				if (!gates.has(url)) gates.set(url, deferred());
				return gates.get(url);
			},
		});
		const uploads = queue(fake);

		const running = uploads.enqueue([candidate('halted.bin', 1024)]);
		await vi.waitFor(() => expect(gates.size).toBe(1));
		uploads.cancel('id-halted.bin');
		for (const gate of gates.values()) gate.resolve({ etag: '"x"' });
		await running;

		expect(uploads.items()[0]?.status).toBe('cancelled');
		expect(fake.cancelled).toEqual(['id-halted.bin']);
		expect(fake.calls).not.toContain('complete');
	});

	it('reports progress that only ever moves forward', async () => {
		const fake = fakeTransport({ partSize: 1 * MIB });
		const seen: number[] = [];
		const uploads = queue(fake, {
			onChange: (items) => {
				const progress = items[0]?.progress;
				if (progress !== undefined) seen.push(progress);
			},
		});

		await uploads.enqueue([candidate('tracked.bin', 5 * MIB)]);

		expect(seen.length).toBeGreaterThan(1);
		expect([...seen].sort((a, b) => a - b)).toEqual(seen);
		// Only the confirmed upload counts as finished.
		expect(seen.at(-1)).toBe(1);
		expect(seen.slice(0, -1).every((value) => value < 1)).toBe(true);
	});

	it('clears confirmed and cancelled work while preserving failures', async () => {
		const fake = fakeTransport({
			failParts: (url) => url.includes('failed'),
		});
		const uploads = queue(fake, { maxAttempts: 1 });

		await uploads.enqueue([
			candidate('done.bin', 1024),
			candidate('failed.bin', 1024),
		]);
		uploads.clearSettled();

		expect(uploads.items().map((item) => [item.name, item.status])).toEqual([
			['failed.bin', 'failed'],
		]);
	});
});
