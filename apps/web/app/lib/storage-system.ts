import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import type { AppSystem } from '@web/lib/app-systems';
import { storageBreadcrumb } from '@web/lib/storage';
import { FolderIcon, FolderOpenIcon } from 'lucide-react';

const STORAGE_PATH = '/storage';

export const storageSystem: AppSystem = {
	key: 'storage',
	heading: 'Storage',
	icon: FolderOpenIcon,

	/**
	 * Storage keeps no local database, and the shell resolves every system
	 * inside a single Dexie `useLiveQuery`: contributing commands from here
	 * would refetch the whole file index on every unrelated Notes change.
	 */
	async loadCommands() {
		return [];
	},

	async loadBreadcrumbTrail(pathname, search): Promise<AppBreadcrumbItem[]> {
		if (pathname !== STORAGE_PATH) return [];
		const folder = new URLSearchParams(search).get('path');

		// Derived entirely from the URL, so the trail costs no request at all.
		return storageBreadcrumb(folder).map(({ label, path }) => ({
			key: `folder:${path}`,
			label,
			path: `${STORAGE_PATH}?path=${encodeURIComponent(path)}`,
			icon: FolderIcon,
		}));
	},
};
