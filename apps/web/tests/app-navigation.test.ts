import {
	appNavigation,
	getBreadcrumbItems,
	getNavigationItem,
} from '@web/lib/app-navigation';
import { HouseIcon, NotebookPenIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';

describe('app navigation', () => {
	it('exposes the private product areas at stable static paths', () => {
		expect(appNavigation.map(({ label, path }) => ({ label, path }))).toEqual([
			{ label: 'Overview', path: '/' },
			{ label: 'Agent', path: '/agent' },
			{ label: 'Calendar', path: '/calendar' },
			{ label: 'Notes', path: '/notes' },
			{ label: 'Finance', path: '/finance' },
			{ label: 'Nutrition', path: '/nutrition' },
			{ label: 'Storage', path: '/storage' },
			{ label: 'Credentials', path: '/credentials' },
			{ label: 'Studyo', path: '/studyo' },
		]);
	});

	it('only resolves exact product paths', () => {
		expect(getNavigationItem('/calendar')?.label).toBe('Calendar');
		expect(getNavigationItem('/calendar/event')).toBeUndefined();
		expect(getNavigationItem('/unknown')).toBeUndefined();
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
});
