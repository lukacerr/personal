import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { notesSystem } from '@web/lib/notes-system';
import type { LucideIcon } from 'lucide-react';

export type SystemCommand = {
	/** Unique within the system; the shell namespaces it with the system key. */
	id: string;
	label: string;
	/** Extra text the palette matches against, and shows aligned to the right. */
	detail?: string;
	/** Destination, including any search string. */
	to: string;
};

/**
 * How a solution contributes to the shared app shell.
 *
 * The shell renders the palette and the breadcrumb without knowing which
 * solutions exist or where they keep their data. Adding a system means adding an
 * entry to `appSystems`, not editing the shell.
 *
 * Both loaders are plain async functions rather than hooks: the shell resolves
 * them inside a single `useLiveQuery`, which keeps the Rules of Hooks safe no
 * matter how the registry grows, and still tracks every Dexie table they read.
 */
export type AppSystem = {
	key: string;
	/** Group heading used for this system's commands in the palette. */
	heading: string;
	icon: LucideIcon;
	loadCommands: () => Promise<SystemCommand[]>;
	/**
	 * Trailing breadcrumb items for the record this route has open, or an empty
	 * array when the route belongs to another system or has none.
	 */
	loadBreadcrumbTrail: (
		pathname: string,
		search: string,
	) => Promise<AppBreadcrumbItem[]>;
};

export const appSystems: AppSystem[] = [notesSystem];

export type SystemCommandGroup = {
	system: AppSystem;
	commands: SystemCommand[];
};

export async function loadSystemCommands(): Promise<SystemCommandGroup[]> {
	return Promise.all(
		appSystems.map(async (system) => ({
			system,
			commands: await system.loadCommands(),
		})),
	);
}

export async function loadSystemBreadcrumbTrail(
	pathname: string,
	search: string,
): Promise<AppBreadcrumbItem[]> {
	const trails = await Promise.all(
		appSystems.map((system) => system.loadBreadcrumbTrail(pathname, search)),
	);
	return trails.flat();
}
