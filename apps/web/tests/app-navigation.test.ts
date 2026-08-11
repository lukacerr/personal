import {
	APP_DEFAULT_PATH,
	appNavigation,
	getBreadcrumbItems,
	getNavigationItem,
} from '@web/lib/app-navigation';
import { noteBreadcrumbTrail } from '@web/lib/notes-system';
import {
	FileTextIcon,
	FolderIcon,
	HouseIcon,
	NotebookPenIcon,
} from 'lucide-react';
import { describe, expect, it } from 'vitest';

describe('app navigation', () => {
	it('exposes the private product areas at stable static paths', () => {
		expect(appNavigation.map(({ label, path }) => ({ label, path }))).toEqual([
			{ label: 'Agent', path: '/agent' },
			{ label: 'Calendar', path: '/calendar' },
			{ label: 'Notes', path: '/notes' },
			{ label: 'Finance', path: '/finance' },
			{ label: 'Nutrition', path: '/nutrition' },
			{ label: 'Storage', path: '/storage' },
			{ label: 'Credentials', path: '/credentials' },
		]);
	});

	/**
	 * The root redirects here, so the two have to agree. Renaming that route
	 * without updating the constant would send every fresh start — a new device, a
	 * cleared browser — to a path that no longer resolves.
	 */
	it('defaults the root to a path navigation actually offers', () => {
		expect(appNavigation.map(({ path }) => path)).toContain(APP_DEFAULT_PATH);
	});

	/** Nothing sits at `/` any more, so it gets the plain workspace crumb. */
	it('leaves the root with no product area of its own', () => {
		expect(getNavigationItem('/')).toBeUndefined();
		expect(getBreadcrumbItems('/')).toEqual([
			{ key: 'home', label: 'Personal', icon: HouseIcon, current: true },
		]);
	});

	it('builds a workspace breadcrumb for product pages', () => {
		const notesItems = getBreadcrumbItems('/notes');

		expect(
			notesItems.map((item) => ({
				label: item.label,
				path: 'path' in item ? item.path : undefined,
			})),
		).toEqual([
			{ label: 'Personal', path: '/' },
			{ label: 'Notes', path: undefined },
		]);
		expect(notesItems[0]?.icon).toBe(HouseIcon);
		expect(notesItems[1]?.icon).toBe(NotebookPenIcon);
		expect(getBreadcrumbItems('/')[0]?.icon).toBe(HouseIcon);
	});

	it('includes the selected note path and title in the Notes breadcrumb', () => {
		const items = getBreadcrumbItems(
			'/notes',
			noteBreadcrumbTrail({
				title: 'Launch plan',
				path: 'work/projects',
			}),
		);

		expect(items.map(({ label }) => label)).toEqual([
			'Personal',
			'Notes',
			'work',
			'projects',
			'Launch plan',
		]);
		expect(items[1]).toMatchObject({ path: '/notes' });
		expect(items[2]?.icon).toBe(FolderIcon);
		expect(items[3]?.icon).toBe(FolderIcon);
		expect(items[4]?.icon).toBe(FileTextIcon);
		expect(items.at(-1)).toMatchObject({ current: true });
	});
});
