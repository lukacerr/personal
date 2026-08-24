import {
	createIndexCore,
	type IndexCore,
	type IndexLoadOutcome,
} from '@web/lib/index-store';
import type { SessionWorkGuard } from '@web/lib/session-work';
import { listFiles, type StoredFile } from '@web/lib/storage-api';
import { create } from 'zustand';

type StorageState = IndexCore & {
	files: StoredFile[];
	/** Fetches the index unless it is already there; `force` refreshes it. */
	load: (
		force?: boolean,
		isCurrent?: SessionWorkGuard,
	) => Promise<IndexLoadOutcome>;
	reset: () => void;
	replace: (files: StoredFile[]) => void;
	upsert: (files: StoredFile[]) => void;
	remove: (ids: string[]) => void;
};

/**
 * The one copy of the file index the app keeps.
 *
 * Storage is not local-first — there is no Dexie and no outbox — but three
 * places now need the same list: the explorer, the Notes file picker and the
 * command palette. Fetching it three times would be three answers that disagree
 * the moment one of them writes.
 */
export const useStorageStore = create<StorageState>()((set, get) => ({
	files: [],
	...createIndexCore<StorageState, StoredFile>({
		get,
		patch: ({ items, ...core }) =>
			set(items ? { ...core, files: items } : core),
		read: async (knownTag) => {
			const answer = await listFiles(knownTag);
			return answer === 'unchanged'
				? answer
				: { items: answer.files, tag: answer.tag };
		},
		select: (state) => state.files,
		failure: {
			unreachable: 'Your files could not be loaded. Try again in a moment.',
			offline: 'No connection. Storage needs to reach the server.',
		},
	}),

	replace: (files) =>
		set({ files, tag: undefined, status: 'ready', error: undefined }),
}));

/** Reads the index without subscribing, for the system registry's loaders. */
export const storageSnapshot = () => useStorageStore.getState();
