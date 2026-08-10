import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import { collectFolderPaths, storageBreadcrumb } from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { storageSnapshot, useStorageStore } from '@web/lib/storage-store';
import { FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react';

const STORAGE_PATH = '/storage';

function storagePath(params: Record<string, string>) {
	return `${STORAGE_PATH}?${new URLSearchParams(params).toString()}`;
}

/** At most this many folders, so files always have room in the results. */
const FOLDER_RESULTS = 5;

let cachedFor: StoredFile[] | undefined;
let cachedFolders: Array<string | null> = [];

/**
 * The folders implied by the index, derived once per index rather than once
 * per keystroke. Deriving them costs milliseconds over a few thousand files
 * and the answer only changes when the files do — and the store replaces the
 * array whenever that happens, so identity is exactly the right question.
 */
function folderPaths(files: StoredFile[]) {
	if (files !== cachedFor) {
		cachedFor = files;
		cachedFolders = collectFolderPaths(files);
	}
	return cachedFolders;
}

export const storageSystem: AppSystem = {
	key: 'storage',
	heading: 'Storage',
	icon: FolderOpenIcon,

	/**
	 * Storage keeps no local database, so nothing the shell watches would ever
	 * tell it these commands changed. The store reports for itself instead.
	 */
	subscribe: (onChange) => useStorageStore.subscribe(onChange),

	/**
	 * The index is fetched the first time somebody actually searches, not when
	 * the shell mounts: most visits never open Storage, and paying for the whole
	 * file list on every page load to fill a palette nobody opened is a cost
	 * with no reader. The `subscribe` above brings the results in once it lands.
	 */
	async searchCommands(query, limit) {
		const { files, status, load } = storageSnapshot();
		if (status === 'idle') void load();

		const folders = folderPaths(files)
			.flatMap((path) =>
				path === null || !matchesCommandQuery(query, path)
					? []
					: [
							{
								id: `folder:${path}`,
								label: path.split('/').at(-1) ?? path,
								detail: path,
								to: storagePath({ path }),
							},
						],
			)
			// Bounded on its own: thousands of matching folders would otherwise
			// spend the whole budget and no file would ever be offered.
			.slice(0, FOLDER_RESULTS);
		const matches = files
			.filter((file) => matchesCommandQuery(query, file.name, file.path))
			.slice(0, limit)
			.map((file) => ({
				id: file.id,
				label: file.name,
				detail: file.path ?? 'Root',
				// Carries the folder as well as the file so the explorer behind the
				// preview is showing where the file actually lives.
				to: storagePath({
					...(file.path ? { path: file.path } : {}),
					file: file.id,
				}),
			}));

		return [...folders, ...matches].slice(0, limit);
	},

	async loadBreadcrumbTrail(pathname, search): Promise<AppBreadcrumbItem[]> {
		if (pathname !== STORAGE_PATH) return [];
		const params = new URLSearchParams(search);
		const folder = params.get('path');
		const openFile = params.get('file');

		// Derived entirely from the URL, so the trail costs no request at all.
		const trail = storageBreadcrumb(folder).map(({ label, path }) => ({
			key: `folder:${path}`,
			label,
			path: storagePath({ path }),
			icon: FolderIcon,
		}));

		if (!openFile) return trail;
		const name = storageSnapshot().files.find(
			(file) => file.id === openFile,
		)?.name;
		return name
			? [...trail, { key: 'file', label: name, icon: FileIcon }]
			: trail;
	},
};
