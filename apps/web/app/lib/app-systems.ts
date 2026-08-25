import { agentSystem } from '@web/lib/agent-system';
import { type AppBreadcrumbItem, appNavigation } from '@web/lib/app-navigation';
import { calendarSystem } from '@web/lib/calendar-system';
import { credentialsSystem } from '@web/lib/credentials-system';
import { financeSystem } from '@web/lib/finance-system';
import {
	type IndexLoadOutcome,
	indexLoadSucceeded,
} from '@web/lib/index-store';
import { notesSystem } from '@web/lib/notes-system';
import {
	type SessionWorkGuard,
	suspendSessionWork,
} from '@web/lib/session-work';
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
 * One line of a system's summary: what it is, and what it currently says.
 *
 * Deliberately one shape for readings and for records alike — `label: 'Left
 * over'` with `detail: '$ 123.456'` is the same row as `label: 'Dentista'` with
 * `detail: 'mañana 15:00'`. A per-system shape would mean the shell rendering
 * finance differently from calendar, which is the one thing it must not know.
 */
export type SystemSummaryRow = {
	/** Unique within this system's summary; the shell namespaces it by key. */
	key: string;
	label: string;
	/** The value, aligned to the right: a time, an amount, a count. */
	detail?: string;
	/** Where the row leads. A reading — a total — has nowhere to go. */
	to?: string;
};

/** What a system currently has to say in the sidebar. */
export type SystemSummary = { rows: SystemSummaryRow[] };

/**
 * How a solution contributes to the shared app shell.
 *
 * The shell renders the palette, the breadcrumb and the sidebar summary without
 * knowing which solutions exist or where they keep their data. Adding a system
 * means adding an entry to `appSystems`, not editing the shell.
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
	 * The handful of lines this system shows in the sidebar, from any screen.
	 *
	 * Takes no arguments on purpose: it renders next to the navigation, where
	 * there is no route and no selection to speak of — a system that wants to
	 * say something here has to be able to say it from anywhere.
	 *
	 * Returning no rows means the group is not rendered at all. That is the
	 * ordinary case, not an error: Notes has nothing to report when everything
	 * is synced, and an empty box saying so permanently is worse than no box.
	 */
	loadSummary?: () => Promise<SystemSummary | undefined>;
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
	/**
	 * Pulls this system's state from the server, for the shell's shared refresh
	 * on returning to the machine.
	 *
	 * Receives the route's search string because what is on screen can be part of
	 * what needs pulling — Notes reloads the open note. Resolves `false` when the
	 * pull failed, so the shell knows not to count it and can retry; a system
	 * reports the failure itself, where its own screen can show it.
	 */
	refresh?: (search: string, isCurrent: SessionWorkGuard) => Promise<boolean>;
	/**
	 * Refresh this system from any screen, not only its own route.
	 *
	 * For the two reasons that survive scrutiny: its index is read from
	 * everywhere — the command palette queries Notes and Agent whatever is on
	 * screen — or it holds a queue that must ship as soon as there is a
	 * connection, as Calendar's outbox does. It replaced a `Bootstrap` component
	 * per system, each of which had hand-rolled its own mount pull and `online`
	 * listener without the staleness gate, the failure backoff or the session
	 * guard the coordinator already owns.
	 *
	 * Off by default on purpose: a system whose data nobody reads from elsewhere
	 * would be spending requests nobody looks at, which is what the no-polling
	 * rule exists to prevent. It still ages on its own clock, so declaring it
	 * costs one conditional request per stale window, not one per signal.
	 */
	refreshEverywhere?: boolean;
	/**
	 * Erases this system's local footprint (databases, queues). The shell runs
	 * every one on sign-out; a system the shell does not know by name still gets
	 * its data cleared.
	 */
	clearLocalData?: () => Promise<void> | void;
};

/** A deep link into a system: its path plus the state carried in the query. */
export function systemPath(base: string, params: Record<string, string>) {
	return `${base}?${new URLSearchParams(params).toString()}`;
}

/**
 * The `refresh` of a system whose index is one of the Zustand stores.
 *
 * `force` is what gets past the guard that skips a load once the store is
 * `ready` — without it, returning to the screen after an hour re-reads the copy
 * already in memory. The store still sends `If-None-Match`, so an unchanged
 * index is a 304.
 *
 * The outcome comes from the call, never from reading `status` back afterwards:
 * `status` is shared, so an interleaved search or a second caller flipping it
 * between the await and the read would decide this pull's verdict — crediting a
 * failed refresh as fresh, or backing off a system that had just succeeded.
 */
export function refreshIndexStore(store: {
	getState: () => {
		load: (
			force?: boolean,
			isCurrent?: SessionWorkGuard,
		) => Promise<IndexLoadOutcome>;
	};
}) {
	return async (_search: string, isCurrent: SessionWorkGuard) => {
		const outcome = await store.getState().load(true, isCurrent);
		return isCurrent() && indexLoadSucceeded(outcome);
	};
}

/**
 * Sign-out's local wipe. Every system is attempted even if one fails, and the
 * first failure is rethrown so the caller can say something went wrong.
 */
export async function clearLocalSystemData() {
	suspendSessionWork();
	const results = await Promise.allSettled(
		appSystems.map((system) => system.clearLocalData?.()),
	);
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	);
	if (failure) throw failure.reason;
}

export const appSystems: AppSystem[] = [
	agentSystem,
	calendarSystem,
	credentialsSystem,
	financeSystem,
	notesSystem,
	storageSystem,
];

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

/**
 * Where a system sits in the sidebar, which is the order the palette lists
 * solutions in too — the two readings of "what is in this app" should agree.
 *
 * Keyed off `/<key>`, so a system's key has to name its route. Sorting here
 * rather than by hand in `appSystems` means adding a system stays a one-line
 * append with no second list to keep in sync. A system with no navigation entry
 * sorts last instead of disappearing.
 */
const navigationRank = (system: AppSystem) => {
	const index = appNavigation.findIndex(
		({ path }) => path === `/${system.key}`,
	);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

/**
 * The system a route belongs to, or none for a screen that is not one.
 *
 * Reads the path off the key, the same convention `navigationRank` already
 * depends on. Nested paths belong to their system so a future `/notes/:id`
 * needs nothing here, while `/notesomething` stays unclaimed.
 */
export function activeSystem(pathname: string) {
	return appSystems.find(({ key }) => {
		const base = `/${key}`;
		return pathname === base || pathname.startsWith(`${base}/`);
	});
}

/** The registry as the sidebar reads it, whatever order it was declared in. */
export const systemsInSidebarOrder = () =>
	[...appSystems].sort((a, b) => navigationRank(a) - navigationRank(b));

/**
 * `limit` caps the whole answer, not each system's share: every system may
 * return up to `limit` matches, and the total is then trimmed in sidebar order
 * — earlier systems keep their results, the overflow comes out of the last.
 * Without the total cap, five systems à 25 results is a 125-row palette.
 */
export async function searchSystemCommands(
	query: string,
	limit: number,
): Promise<SystemCommandGroup[]> {
	const groups = await Promise.all(
		systemsInSidebarOrder().map(async (system) => ({
			system,
			commands: await system.searchCommands(query, limit),
		})),
	);

	let remaining = limit;
	const capped: SystemCommandGroup[] = [];
	for (const group of groups) {
		if (remaining <= 0) break;
		const commands = group.commands.slice(0, remaining);
		if (commands.length === 0) continue;
		remaining -= commands.length;
		capped.push({ system: group.system, commands });
	}
	return capped;
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

export type SystemSummaryGroup = { system: AppSystem; summary: SystemSummary };

/**
 * Every system's summary, in sidebar order, skipping the ones with nothing to
 * say.
 *
 * The emptiness check lives here rather than in the sidebar so that "a system
 * with no rows contributes no group" is one rule in one place, and the
 * component stays a `map` over what it was handed.
 */
export async function loadSystemSummaries(): Promise<SystemSummaryGroup[]> {
	const groups = await Promise.all(
		systemsInSidebarOrder().map(async (system) => ({
			system,
			summary: await system.loadSummary?.(),
		})),
	);
	return groups.filter(
		(group): group is SystemSummaryGroup =>
			(group.summary?.rows.length ?? 0) > 0,
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
