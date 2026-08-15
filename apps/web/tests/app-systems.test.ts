import 'fake-indexeddb/auto';
import { appNavigation } from '@web/lib/app-navigation';
import {
	appSystems,
	clearLocalSystemData,
	getSystemDataRevision,
	searchSystemCommands,
	subscribeToSystemData,
	systemsInSidebarOrder,
} from '@web/lib/app-systems';
import { calendarDb, type LocalEvent } from '@web/lib/calendar-db';
import type { Credential } from '@web/lib/credentials-api';
import { useCredentialsStore } from '@web/lib/credentials-store';
import { useFinanceStore } from '@web/lib/finance-store';
import { type LocalNote, notesDb } from '@web/lib/notes-db';
import type { StoredFile } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
	useFinanceStore.setState({ payments: [], status: 'idle' });
	useCredentialsStore.setState({ credentials: [], status: 'idle' });
	useStorageStore.setState({ files: [], status: 'idle' });
});

describe('the system registry', () => {
	/**
	 * The palette lists solutions in the order the sidebar does, so the two
	 * readings of "what is in this app" agree. The registry array is not that
	 * order — sorting happens at the point of use, so adding a system stays a
	 * one-line append with no second list to keep in sync.
	 */
	it('reads in sidebar order, whatever order it was declared in', () => {
		const ordered = systemsInSidebarOrder().map((system) => `/${system.key}`);
		const expected = appNavigation
			.map(({ path }) => path)
			.filter((path) => ordered.includes(path));

		expect(ordered).toEqual(expected);
		expect(ordered).toHaveLength(appSystems.length);
	});

	/**
	 * The rank keys off `/<key>`, so a system whose key stopped naming its route
	 * would silently sink to the bottom instead of failing here.
	 */
	it('gives every system a key that names its route', () => {
		const paths = new Set<string>(appNavigation.map(({ path }) => path));
		for (const system of appSystems)
			expect(paths.has(`/${system.key}`)).toBe(true);
	});

	/**
	 * The shell resolves loaders on every revision bump, so a store that
	 * reported every `set` — a status flip, an error — would re-run every
	 * system's search for data that did not move.
	 */
	it('reports system data only when the data itself changes', () => {
		const notifications: number[] = [];
		const stop = subscribeToSystemData(() =>
			notifications.push(getSystemDataRevision()),
		);

		useFinanceStore.setState({ status: 'loading' });
		useCredentialsStore.setState({ status: 'loading' });
		useStorageStore.setState({ status: 'loading' });
		expect(notifications).toHaveLength(0);

		useFinanceStore.setState({ payments: [] });
		expect(notifications).toHaveLength(1);

		stop();
	});

	/**
	 * Each system caps its own answer, but the palette shows one list: without
	 * a total cap, five systems à 25 results is a 125-row palette.
	 */
	it('caps the total command count while keeping sidebar order', async () => {
		useCredentialsStore.setState({
			status: 'ready',
			credentials: Array.from(
				{ length: 30 },
				(_, index) =>
					({ id: `c${index}`, title: `Credential ${index}` }) as Credential,
			),
		});
		useStorageStore.setState({
			status: 'ready',
			files: Array.from(
				{ length: 10 },
				(_, index) =>
					({
						id: `f${index}`,
						name: `file-${index}.txt`,
						path: null,
					}) as StoredFile,
			),
		});

		const groups = await searchSystemCommands('', 25);
		const total = groups.reduce(
			(count, group) => count + group.commands.length,
			0,
		);

		expect(total).toBe(25);
		expect(groups.map((group) => group.system.key)).toEqual([
			'calendar',
			'finance',
			'storage',
			'credentials',
		]);
		// The overflow comes out of the last group, never the earlier ones.
		expect(groups.at(-1)?.commands).toHaveLength(13);
	});

	/**
	 * Sign-out must erase every system's local footprint, not just the ones the
	 * shell happened to know by name — that is how Calendar's queue survived a
	 * sign-out while Notes' did not.
	 */
	it('clears every system’s local data on sign-out', async () => {
		expect(appSystems.some((system) => system.clearLocalData)).toBe(true);
		expect(appSystems.some((system) => system.Bootstrap)).toBe(true);

		await notesDb.notes.put({
			id: 'n1',
			title: 'Private note',
			path: null,
			isPublic: false,
			createdAt: 1,
			updatedAt: 1,
			dirty: false,
		} as LocalNote);
		await calendarDb.events.put({
			id: 'e1',
			title: 'Private event',
			updatedAt: 1,
		} as LocalEvent);

		await clearLocalSystemData();

		expect(await notesDb.notes.count()).toBe(0);
		expect(await calendarDb.events.count()).toBe(0);
	});
});
