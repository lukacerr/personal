import { describe, expect, it } from 'bun:test';
import { deleteStoredFiles } from '@api/files-delete';

describe('Stored file deletion', () => {
	it('never deletes metadata when object storage fails', async () => {
		const rowsDeleted: string[] = [];
		const result = await deleteStoredFiles(['a', 'b'], {
			deleteObject: async (id) => {
				if (id === 'a') throw new Error('S3 unavailable');
			},
			deleteRow: async (id) => {
				rowsDeleted.push(id);
			},
		});

		expect(rowsDeleted).toEqual(['b']);
		expect(result).toEqual({
			deleted: ['b'],
			failed: [{ id: 'a', error: 'STORAGE_DELETE_FAILED' }],
		});
	});

	it('reports a database failure after the object is gone', async () => {
		const objectsDeleted: string[] = [];
		const result = await deleteStoredFiles(['a'], {
			deleteObject: async (id) => {
				objectsDeleted.push(id);
			},
			deleteRow: async () => {
				throw new Error('database unavailable');
			},
		});

		expect(objectsDeleted).toEqual(['a']);
		expect(result.failed).toEqual([
			{ id: 'a', error: 'DATABASE_DELETE_FAILED' },
		]);
	});

	it('bounds deletion concurrency', async () => {
		let active = 0;
		let peak = 0;
		const gates: Array<() => void> = [];
		const running = deleteStoredFiles(
			Array.from({ length: 12 }, (_, index) => String(index)),
			{
				deleteObject: async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise<void>((resolve) => gates.push(resolve));
					active -= 1;
				},
				deleteRow: async () => undefined,
			},
			4,
		);

		while (gates.length < 4) await Bun.sleep(1);
		expect(peak).toBe(4);
		while (gates.length > 0) gates.shift()?.();
		for (let released = 4; released < 12; released += 4) {
			while (gates.length < Math.min(4, 12 - released)) await Bun.sleep(1);
			while (gates.length > 0) gates.shift()?.();
		}
		await running;
		expect(peak).toBe(4);
	});
});
