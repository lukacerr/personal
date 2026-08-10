/**
 * The upload machine: reservation, part planning, concurrency, retries,
 * progress and cancellation.
 *
 * Its transport is injected, so the whole thing is testable without a network
 * or a bucket. The UI only renders what `items()` reports.
 */

export type UploadRequest = {
	id: string;
	name: string;
	path: string | null;
	contentType: string;
	size: number;
	/** Set by the Notes editor so Storage can tell where a file came from. */
	uploadedFromNotes?: boolean;
};

export type UploadCandidate = UploadRequest & { body: Blob };

export type UploadReservation =
	| {
			id: string;
			status: 'ready';
			mode: 'single' | 'multipart';
			partSize: number;
			partCount: number;
			url?: string;
	  }
	| { id: string; status: 'rejected'; error?: string };

export type SignedPart = { partNumber: number; url: string };

export type UploadedPart = { partNumber: number; etag: string };

export type PutOptions = {
	contentType?: string;
	signal?: AbortSignal;
	/** Fraction of this part that has been sent, from 0 to 1. */
	onProgress?: (fraction: number) => void;
};

export type UploadTransport = {
	reserve: (requests: UploadRequest[]) => Promise<UploadReservation[]>;
	signParts: (id: string, partNumbers: number[]) => Promise<SignedPart[]>;
	put: (
		url: string,
		body: Blob,
		options: PutOptions,
	) => Promise<{ etag: string | null }>;
	complete: (id: string, parts: UploadedPart[]) => Promise<unknown>;
	cancel: (id: string) => Promise<void>;
};

export type UploadStatus =
	| 'pending'
	| 'uploading'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type UploadItem = {
	id: string;
	name: string;
	path: string | null;
	size: number;
	status: UploadStatus;
	/** From 0 to 1, and only 1 once the server confirmed the upload. */
	progress: number;
	error?: string;
};

export type UploadQueueOptions = {
	transport: UploadTransport;
	/** Files transferring at once. A browser limit, not a product one. */
	fileConcurrency?: number;
	/** Parts of one file in flight at once. */
	partConcurrency?: number;
	partBatchSize?: number;
	maxAttempts?: number;
	onChange?: (items: UploadItem[]) => void;
	delay?: (ms: number) => Promise<void>;
};

const RESERVATION_ERRORS: Record<string, string> = {
	NAME_TAKEN: 'A file with this name already exists in this folder.',
	UPLOAD_UNAVAILABLE: 'Storage refused this upload. Try again in a moment.',
};

const STATUS_ERRORS: Record<number, string> = {
	410: 'This upload took too long and expired. Try again.',
	409: 'The file did not arrive completely. Try again.',
	422: 'The server rejected this file.',
};

export function describeUploadFailure(error: unknown) {
	const status = (error as { status?: number } | null | undefined)?.status;
	if (status && STATUS_ERRORS[status]) return STATUS_ERRORS[status];
	if (status && status >= 500)
		return 'The server could not be reached. Try again in a moment.';
	return 'The upload failed. Try again.';
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs tasks with a bounded number in flight, preserving their order. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number) {
	const results: T[] = new Array(tasks.length);
	let next = 0;

	async function worker() {
		while (next < tasks.length) {
			const index = next;
			next += 1;
			const task = tasks[index];
			if (task) results[index] = await task();
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, tasks.length) }, worker),
	);
	return results;
}

export function createUploadQueue({
	transport,
	fileConcurrency = 3,
	partConcurrency = 4,
	partBatchSize = 50,
	maxAttempts = 3,
	onChange,
	delay = sleep,
}: UploadQueueOptions) {
	const items = new Map<string, UploadItem>();
	const controllers = new Map<string, AbortController>();
	const cancelled = new Set<string>();

	function emit() {
		onChange?.([...items.values()]);
	}

	function update(id: string, patch: Partial<UploadItem>) {
		const current = items.get(id);
		if (!current) return;
		items.set(id, { ...current, ...patch });
		emit();
	}

	/**
	 * Retries a part rather than the file: one lost part out of two hundred has
	 * no business tearing down an upload that is otherwise going fine.
	 */
	async function putWithRetry(
		url: string,
		body: Blob,
		options: PutOptions,
	): Promise<{ etag: string | null }> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				return await transport.put(url, body, options);
			} catch (error) {
				lastError = error;
				if (options.signal?.aborted) throw error;
				if (attempt < maxAttempts) await delay(2 ** attempt * 100);
			}
		}
		throw lastError;
	}

	async function transfer(
		candidate: UploadCandidate,
		reservation: Extract<UploadReservation, { status: 'ready' }>,
	) {
		const controller = new AbortController();
		controllers.set(candidate.id, controller);
		update(candidate.id, { status: 'uploading', progress: 0 });

		const { partSize, partCount } = reservation;
		// Progress counts bytes rather than finished parts, or a large file
		// would sit frozen for minutes between parts.
		const sent = new Array<number>(partCount).fill(0);
		const report = () => {
			const total = sent.reduce((sum, value) => sum + value, 0);
			// Capped below 1: only the server confirming the upload finishes it.
			update(candidate.id, {
				progress: Math.min(0.99, total / Math.max(candidate.size, 1)),
			});
		};

		if (reservation.mode === 'single') {
			if (!reservation.url) throw new Error('Reservation carried no URL');
			await putWithRetry(reservation.url, candidate.body, {
				contentType: candidate.contentType,
				signal: controller.signal,
				onProgress: (fraction) => {
					sent[0] = fraction * candidate.size;
					report();
				},
			});
		} else {
			const uploaded: UploadedPart[] = [];
			for (let start = 1; start <= partCount; start += partBatchSize) {
				if (controller.signal.aborted) break;
				const partNumbers = Array.from(
					{ length: Math.min(partBatchSize, partCount - start + 1) },
					(_, index) => start + index,
				);
				// Signed in batches: a five terabyte file has ten thousand parts,
				// and signatures asked for hours in advance would be stale.
				const signed = await transport.signParts(candidate.id, partNumbers);

				const results = await pool(
					signed.map(({ partNumber, url }) => async () => {
						const chunk = candidate.body.slice(
							(partNumber - 1) * partSize,
							partNumber * partSize,
						);
						const { etag } = await putWithRetry(url, chunk, {
							signal: controller.signal,
							onProgress: (fraction) => {
								sent[partNumber - 1] = fraction * chunk.size;
								report();
							},
						});
						return { partNumber, etag: etag ?? '' };
					}),
					partConcurrency,
				);
				uploaded.push(...results);
			}

			if (!controller.signal.aborted)
				await transport.complete(candidate.id, uploaded);
			controllers.delete(candidate.id);
			return;
		}

		if (!controller.signal.aborted) await transport.complete(candidate.id, []);
		controllers.delete(candidate.id);
	}

	async function run(
		candidate: UploadCandidate,
		reservation: UploadReservation,
	) {
		if (reservation.status === 'rejected') {
			update(candidate.id, {
				status: 'failed',
				error:
					RESERVATION_ERRORS[reservation.error ?? ''] ??
					'This file could not be uploaded.',
			});
			return;
		}

		try {
			await transfer(candidate, reservation);
			if (cancelled.has(candidate.id)) {
				// Cancelling mid-transfer still has to release the reservation, or
				// the name stays held until it expires on its own.
				await transport.cancel(candidate.id).catch(() => undefined);
				update(candidate.id, { status: 'cancelled', progress: 0 });
				return;
			}
			update(candidate.id, { status: 'completed', progress: 1 });
		} catch (error) {
			await transport.cancel(candidate.id).catch(() => undefined);
			update(candidate.id, {
				status: cancelled.has(candidate.id) ? 'cancelled' : 'failed',
				error: cancelled.has(candidate.id)
					? undefined
					: describeUploadFailure(error),
			});
		} finally {
			controllers.delete(candidate.id);
		}
	}

	return {
		items: () => [...items.values()],

		/** One reservation request for the whole selection, then bounded transfers. */
		async enqueue(candidates: UploadCandidate[]) {
			for (const candidate of candidates)
				items.set(candidate.id, {
					id: candidate.id,
					name: candidate.name,
					path: candidate.path,
					size: candidate.size,
					status: 'pending',
					progress: 0,
				});
			emit();

			const reservations = await transport.reserve(
				candidates.map(({ body: _body, ...request }) => request),
			);
			const byId = new Map(
				reservations.map((reservation) => [reservation.id, reservation]),
			);

			await pool(
				candidates.map((candidate) => async () => {
					const reservation = byId.get(candidate.id);
					if (!reservation) {
						update(candidate.id, {
							status: 'failed',
							error: 'The server did not accept this file.',
						});
						return;
					}
					await run(candidate, reservation);
				}),
				fileConcurrency,
			);
		},

		cancel(id: string) {
			cancelled.add(id);
			controllers.get(id)?.abort();
		},

		/** Drops finished entries so the panel only shows what still matters. */
		clearSettled() {
			for (const [id, item] of items)
				if (item.status === 'completed' || item.status === 'cancelled')
					items.delete(id);
			emit();
		},

		remove(id: string) {
			items.delete(id);
			emit();
		},
	};
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;
