import { appNavigation } from '@web/lib/app-navigation';
import { appSystems, systemsInSidebarOrder } from '@web/lib/app-systems';
import { describe, expect, it } from 'vitest';

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
});
