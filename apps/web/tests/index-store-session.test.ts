// @vitest-environment happy-dom
import type { Credential } from '@web/lib/credentials-api';
import { useCredentialsStore } from '@web/lib/credentials-store';
import type { Payment } from '@web/lib/finance-api';
import { useFinanceStore } from '@web/lib/finance-store';
import {
	createSessionWorkGuard,
	resumeSessionWork,
	suspendSessionWork,
} from '@web/lib/session-work';
import type { StoredFile } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	listCredentials: vi.fn(),
	listFiles: vi.fn(),
	listPayments: vi.fn(),
	readUsdQuote: vi.fn(),
}));

vi.mock('@web/lib/credentials-api', () => ({
	listCredentials: api.listCredentials,
}));
vi.mock('@web/lib/storage-api', () => ({ listFiles: api.listFiles }));
vi.mock('@web/lib/finance-api', () => ({
	listPayments: api.listPayments,
	readUsdQuote: api.readUsdQuote,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const stores = [
	{
		name: 'Finance',
		api: api.listPayments,
		store: useFinanceStore,
		rows: () => useFinanceStore.getState().payments,
		answer: {
			payments: [{ id: 'payment-1', title: 'Private payment' } as Payment],
			tag: 'payments-tag',
		},
	},
	{
		name: 'Storage',
		api: api.listFiles,
		store: useStorageStore,
		rows: () => useStorageStore.getState().files,
		answer: {
			files: [{ id: 'file-1', name: 'private.txt' } as StoredFile],
			tag: 'files-tag',
		},
	},
	{
		name: 'Credentials',
		api: api.listCredentials,
		store: useCredentialsStore,
		rows: () => useCredentialsStore.getState().credentials,
		answer: {
			credentials: [
				{
					id: 'credential-1',
					title: 'Private credential',
					value: 'ciphertext',
				} as Credential,
			],
			tag: 'credentials-tag',
		},
	},
] as const;

beforeEach(() => {
	resumeSessionWork();
	api.listCredentials.mockReset();
	api.listFiles.mockReset();
	api.listPayments.mockReset();
	api.readUsdQuote.mockReset();
	useFinanceStore.getState().reset();
	useStorageStore.getState().reset();
	useCredentialsStore.getState().reset();
});

afterEach(() => resumeSessionWork());

describe.each(stores)('$name store session boundary', (entry) => {
	it('does not restore private rows after sign-out clears an in-flight load', async () => {
		const response = deferred<(typeof entry)['answer']>();
		entry.api.mockReturnValueOnce(response.promise);
		const guard = createSessionWorkGuard();
		expect(guard).toBeDefined();

		const loading = entry.store.getState().load(true, guard);
		suspendSessionWork();
		entry.store.getState().reset();
		response.resolve(entry.answer);
		await loading;

		const state = entry.store.getState();
		expect(entry.rows()).toEqual([]);
		expect(state.status).toBe('idle');
		expect(state.tag).toBeUndefined();
		expect(state.error).toBeUndefined();
	});

	it('does not replace idle with a stale failure after sign-out', async () => {
		const response = deferred<never>();
		entry.api.mockReturnValueOnce(response.promise);
		const guard = createSessionWorkGuard();
		expect(guard).toBeDefined();

		const loading = entry.store.getState().load(true, guard);
		suspendSessionWork();
		entry.store.getState().reset();
		response.reject(new Error('old session failed'));
		await loading;

		const state = entry.store.getState();
		expect(entry.rows()).toEqual([]);
		expect(state.status).toBe('idle');
		expect(state.error).toBeUndefined();
	});
});

describe('Finance quote session boundary', () => {
	it('does not restore a quote after sign-out resets its in-flight load', async () => {
		const response = deferred<{
			compra: number;
			venta: number;
			fetchedAt: number;
			stale: boolean;
		}>();
		api.readUsdQuote.mockReturnValueOnce(response.promise);
		const guard = createSessionWorkGuard();
		expect(guard).toBeDefined();

		const loading = useFinanceStore.getState().loadQuote(true, guard);
		suspendSessionWork();
		useFinanceStore.getState().reset();
		response.resolve({
			compra: 1_400,
			venta: 1_450,
			fetchedAt: 1,
			stale: false,
		});
		await loading;

		expect(useFinanceStore.getState()).toMatchObject({
			status: 'idle',
			quote: undefined,
			quoteFailed: false,
		});
	});
});
