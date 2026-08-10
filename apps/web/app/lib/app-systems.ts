import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { notesSystem } from '@web/lib/notes-system';
import { storageSystem } from '@web/lib/storage-system';
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
 * Both loaders are plain async functions rather than hooks, so the shell can
 * resolve the whole registry from one effect no matter how it grows. A system
 * whose data lives outside Dexie reports its own changes through `subscribe`.
 */
export type AppSystem = {
	key: string;
	/** Group heading used for this system's commands in the palette. */
	heading: string;
	icon: LucideIcon;
	/**
	 * The commands matching a query, capped by the caller.
	 *
	 * A query rather than a catalogue: asking every system for everything meant
	 * building one command per record before anyone had typed a character, and
	 * then filtering that list again on every keystroke. Each system knows how
	 * to search its own store, and answers with at most what was asked for.
	 * An empty query means "what would you show first".
	 */
	searchCommands: (query: string, limit: number) => Promise<SystemCommand[]>;
	/**
	 * Trailing breadcrumb items for the record this route has open, or an empty
	 * array when the route belongs to another system or has none.
	 */
	loadBreadcrumbTrail: (
		pathname: string,
		search: string,
	) => Promise<AppBreadcrumbItem[]>;
	/**
	 * Tells the shell this system's data changed. Only systems that keep their
	 * data outside Dexie need it: for the rest, the `useLiveQuery` that resolves
	 * the loaders already tracks every table they read.
	 */
	subscribe?: (onChange: () => void) => () => void;
};

export const appSystems: AppSystem[] = [notesSystem, storageSystem];

let systemDataRevision = 0;
const revisionListeners = new Set<() => void>();
let detachSystems: (() => void) | undefined;

/**
 * One signal for every system that reports its own changes.
 *
 * The shell still knows nothing about which solutions exist: it subscribes to
 * the registry as a whole and re-resolves the loaders when anything moves.
 * Systems backed by Dexie contribute nothing here and lose nothing by it.
 */
export function subscribeToSystemData(listener: () => void) {
	revisionListeners.add(listener);
	if (revisionListeners.size === 1) {
		const stops = appSystems.map((system) =>
			system.subscribe?.(() => {
				systemDataRevision += 1;
				for (const notify of revisionListeners) notify();
			}),
		);
		detachSystems = () => {
			for (const stop of stops) stop?.();
		};
	}

	return () => {
		revisionListeners.delete(listener);
		if (revisionListeners.size > 0) return;
		detachSystems?.();
		detachSystems = undefined;
	};
}

export const getSystemDataRevision = () => systemDataRevision;

export type SystemCommandGroup = {
	system: AppSystem;
	commands: SystemCommand[];
};

export async function searchSystemCommands(
	query: string,
	limit: number,
): Promise<SystemCommandGroup[]> {
	const groups = await Promise.all(
		appSystems.map(async (system) => ({
			system,
			commands: await system.searchCommands(query, limit),
		})),
	);
	return groups.filter((group) => group.commands.length > 0);
}

/** Case-insensitive substring, which is what a person means when they type. */
export function matchesCommandQuery(
	query: string,
	...fields: Array<string | null | undefined>
) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return true;
	return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
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
