import { isTransientApiFailure } from '@web/lib/api';
import { getPersistedAuthState } from '@web/lib/auth-store';
import {
	createGoogleLoginUrl,
	createLoginPath,
	decodeOAuthSession,
	getOAuthSessionFromHash,
	getSafeReturnTo,
} from '@web/lib/session';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/env', () => ({
	env: { VITE_ENV: 'development' },
}));

const tokens = {
	at: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imx1a2FAbG9jYWxob3N0In0.signature',
	rt: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imx1a2FAbG9jYWxob3N0In0.refresh',
};

describe('OAuth session', () => {
	it('bootstraps a local development session', async () => {
		const { useAuthStore } = await import('@web/lib/auth-store');

		await useAuthStore.getState().bootstrap();

		expect(useAuthStore.getState()).toMatchObject({
			accessToken: 'dev',
			status: 'authenticated',
		});
	});

	it('persists only the refresh token', () => {
		expect(
			getPersistedAuthState({
				accessToken: tokens.at,
				refreshToken: tokens.rt,
				status: 'authenticated',
			}),
		).toEqual({ refreshToken: tokens.rt });
	});

	it('parses valid callback fragments and rejects malformed data', () => {
		expect(decodeOAuthSession(btoa(JSON.stringify(tokens)))).toEqual(tokens);
		expect(decodeOAuthSession('not-base64')).toBeNull();
		const encodedSession = btoa(JSON.stringify(tokens));

		expect(getOAuthSessionFromHash(`#session=${encodedSession}`)).toEqual(
			tokens,
		);
		expect(getOAuthSessionFromHash('?session=not-a-fragment')).toBeNull();
	});

	it('only accepts local return paths', () => {
		expect(getSafeReturnTo('/calendar?view=week')).toBe('/calendar?view=week');
		expect(getSafeReturnTo('https://example.com')).toBe('/');
		expect(getSafeReturnTo('//example.com')).toBe('/');
		expect(getSafeReturnTo('/\\example.com')).toBe('/');
		expect(getSafeReturnTo('/login')).toBe('/');
		expect(getSafeReturnTo('/auth/callback')).toBe('/');
	});

	it('builds a Google login URL that returns to the requested page', () => {
		const loginUrl = new URL(
			createGoogleLoginUrl({
				apiUrl: 'http://localhost:8080',
				appOrigin: 'http://localhost:5173',
				returnTo: '/finances',
			}),
		);
		const callbackUrl = new URL(loginUrl.searchParams.get('redirect') ?? '');

		expect(loginUrl.pathname).toBe('/auth/google/login');
		expect(callbackUrl.href).toBe(
			'http://localhost:5173/auth/callback?returnTo=%2Ffinances',
		);
	});

	it('preserves the requested page when redirecting to login', () => {
		expect(createLoginPath('/calendar?view=week#today')).toBe(
			'/login?returnTo=%2Fcalendar%3Fview%3Dweek%23today',
		);
		expect(createLoginPath('https://example.com')).toBe('/login?returnTo=%2F');
	});

	/**
	 * Transient means retrying can fix it: the network itself, the server, a
	 * timeout or a rate limit. A 429 on refresh once counted as terminal and
	 * permanently signed the session out for being briefly rate limited.
	 */
	it('survives a transient API failure but not a rejected credential', () => {
		expect(isTransientApiFailure(503)).toBe(true);
		expect(isTransientApiFailure(500)).toBe(true);
		expect(isTransientApiFailure(0)).toBe(true);
		expect(isTransientApiFailure(408)).toBe(true);
		expect(isTransientApiFailure(429)).toBe(true);
		expect(isTransientApiFailure(401)).toBe(false);
		expect(isTransientApiFailure(403)).toBe(false);
		expect(isTransientApiFailure(404)).toBe(false);
	});
});
