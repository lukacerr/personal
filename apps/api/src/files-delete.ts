export type FileDeleteFailure = {
	id: string;
	error: 'STORAGE_DELETE_FAILED' | 'DATABASE_DELETE_FAILED';
};

export type FileDeleteResult = {
	deleted: string[];
	failed: FileDeleteFailure[];
};

/**
 * Deletes each object before its metadata, with bounded storage concurrency.
 * There is no distributed transaction between S3 and Postgres, so partial
 * results are explicit instead of pretending the whole batch was atomic.
 */
export async function deleteStoredFiles(
	ids: string[],
	operations: {
		deleteObject: (id: string) => Promise<void>;
		deleteRow: (id: string) => Promise<void>;
	},
	concurrency = 4,
): Promise<FileDeleteResult> {
	const outcomes: Array<
		| { id: string; deleted: true }
		| { id: string; deleted: false; error: FileDeleteFailure['error'] }
	> = new Array(ids.length);
	let next = 0;

	async function worker() {
		while (next < ids.length) {
			const index = next;
			next += 1;
			const id = ids[index];
			if (!id) continue;

			try {
				await operations.deleteObject(id);
			} catch {
				outcomes[index] = {
					id,
					deleted: false,
					error: 'STORAGE_DELETE_FAILED',
				};
				continue;
			}

			try {
				await operations.deleteRow(id);
				outcomes[index] = { id, deleted: true };
			} catch {
				outcomes[index] = {
					id,
					deleted: false,
					error: 'DATABASE_DELETE_FAILED',
				};
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
	);

	return outcomes.reduce<FileDeleteResult>(
		(result, outcome) => {
			if (!outcome) return result;
			if (outcome.deleted) result.deleted.push(outcome.id);
			else result.failed.push({ id: outcome.id, error: outcome.error });
			return result;
		},
		{ deleted: [], failed: [] },
	);
}
