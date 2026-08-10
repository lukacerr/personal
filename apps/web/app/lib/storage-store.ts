import { listFiles, type StoredFile } from '@web/lib/storage-api';
import { create } from 'zustand';

type StorageStatus = 'idle' | 'loading' | 'ready' | 'failed';

type StorageState = {
	files: StoredFile[];
	status: StorageStatus;
	error?: string;
	/** What the server called the copy held here, so a refresh can ask for less. */
	tag?: string;
	/** Fetches the index unless it is already there; `force` refreshes it. */
	load: (force?: boolean) => Promise<void>;
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
export const useStorageStore = create<StorageState>()((set, get) => {
	// Concurrent callers share one request rather than racing to overwrite each
	// other, the same way `refreshNotes` coalesces in Notes.
	let inFlight: Promise<void> | undefined;

	return {
		files: [],
		status: 'idle',

		async load(force = false) {
			if (inFlight) return inFlight;
			if (!force && get().status === 'ready') return;

			set({ status: 'loading' });
			inFlight = (async () => {
				try {
					const answer = await listFiles(get().tag);
					if (answer === 'unchanged')
						set({ status: 'ready', error: undefined });
					else
						set({
							files: answer.files,
							tag: answer.tag,
							status: 'ready',
							error: undefined,
						});
				} catch {
					set({
						status: 'failed',
						error: navigator.onLine
							? 'Your files could not be loaded. Try again in a moment.'
							: 'No connection. Storage needs to reach the server.',
					});
				} finally {
					inFlight = undefined;
				}
			})();
			return inFlight;
		},

		replace: (files) =>
			set({ files, tag: undefined, status: 'ready', error: undefined }),

		upsert: (updated) => {
			const byId = new Map(updated.map((entry) => [entry.id, entry]));
			// The tag describes what the server sent, and this is no longer that.
			set(({ files }) => {
				const merged = files.map((entry) => byId.get(entry.id) ?? entry);
				const known = new Set(files.map((entry) => entry.id));
				return {
					tag: undefined,
					files: [
						...merged,
						...updated.filter((entry) => !known.has(entry.id)),
					],
				};
			});
		},

		remove: (ids) => {
			const dropped = new Set(ids);
			set(({ files }) => ({
				tag: undefined,
				files: files.filter((entry) => !dropped.has(entry.id)),
			}));
		},
	};
});

/** Reads the index without subscribing, for the system registry's loaders. */
export const storageSnapshot = () => useStorageStore.getState();
