import {
	appNavigation,
	getBreadcrumbItems,
	getNavigationItem,
} from '@web/lib/app-navigation';
import { describe, expect, it } from 'vitest';

describe('app navigation', () => {
	it('exposes the private product areas at stable static paths', () => {
		expect(appNavigation.map(({ label, path }) => ({ label, path }))).toEqual([
			{ label: 'Overview', path: '/' },
			{ label: 'Calendar', path: '/calendar' },
			{ label: 'Finance', path: '/finance' },
			{ label: 'Credentials', path: '/credentials' },
			{ label: 'Storage', path: '/storage' },
			{ label: 'Studyo', path: '/studyo' },
			{ label: 'Nutrition', path: '/nutrition' },
			{ label: 'Agent', path: '/agent' },
		]);
	});

	it('only resolves exact product paths', () => {
		expect(getNavigationItem('/calendar')?.label).toBe('Calendar');
		expect(getNavigationItem('/calendar/event')).toBeUndefined();
		expect(getNavigationItem('/unknown')).toBeUndefined();
	});

	it('builds a workspace breadcrumb for product pages', () => {
		expect(getBreadcrumbItems('/calendar')).toEqual([
			{ label: 'Personal', path: '/' },
			{ label: 'Calendar' },
		]);
		expect(getBreadcrumbItems('/')).toEqual([{ label: 'Personal' }]);
	});
});
