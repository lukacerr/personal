// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react';
import {
	getStartupRedirect,
	rememberAppLocation,
	useStartupRedirect,
} from '@web/lib/app-location';
import { describe, expect, it } from 'vitest';

function storage(values: Record<string, string> = {}) {
	const data = new Map(Object.entries(values));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		data,
	};
}

describe('last app location', () => {
	it('restores a remembered pathname and search only from the root', () => {
		const localStorage = storage();

		rememberAppLocation(localStorage, '/notes?note=note-1#editor');

		expect(localStorage.data.values()).toContain('/notes?note=note-1');
		expect(getStartupRedirect('/', localStorage)).toBe('/notes?note=note-1');
		expect(getStartupRedirect('/calendar', localStorage)).toBeNull();
	});

	it.each([
		undefined,
		'/',
		'//external.example',
		'/login',
		'/auth/callback',
		'not-a-path',
	])(
		'does not redirect to an absent, root, or unsafe saved location: %s',
		(value) => {
			const localStorage = storage(
				value === undefined ? {} : { 'personal-app-location:v1': value },
			);

			expect(getStartupRedirect('/', localStorage)).toBeNull();
		},
	);

	it('tolerates unavailable localStorage', () => {
		const unavailable = {
			getItem: () => {
				throw new Error('Storage unavailable');
			},
			setItem: () => {
				throw new Error('Storage unavailable');
			},
		};

		expect(() => rememberAppLocation(unavailable, '/notes')).not.toThrow();
		expect(getStartupRedirect('/', unavailable)).toBeNull();
	});

	/**
	 * The layout that redirects stays mounted across the navigation, so a target
	 * it never releases replaces the whole app shell with a redirect forever, and
	 * one released too early is spent on the renders that wait for the session.
	 */
	it('holds the remembered location until the app leaves the startup route', () => {
		const localStorage = storage({ 'personal-app-location:v1': '/notes' });
		const { result, rerender } = renderHook(
			({ href }) => useStartupRedirect(href, localStorage),
			{ initialProps: { href: '/' } },
		);

		expect(result.current).toBe('/notes');

		rerender({ href: '/' });
		expect(result.current).toBe('/notes');

		rerender({ href: '/notes' });
		expect(result.current).toBeNull();

		rerender({ href: '/' });
		expect(result.current).toBeNull();
	});

	it('never redirects when there is nothing to restore', () => {
		const localStorage = storage();

		const { result } = renderHook(() => useStartupRedirect('/', localStorage));

		expect(result.current).toBeNull();
	});
});
