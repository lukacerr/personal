import { z } from 'zod';

const sessionSchema = z.object({
	at: z.jwt(),
	rt: z.jwt(),
});

export type SessionTokens = z.infer<typeof sessionSchema>;

export function decodeOAuthSession(value: string): SessionTokens | null {
	try {
		return sessionSchema.parse(JSON.parse(atob(value)));
	} catch {
		return null;
	}
}

export function getOAuthSessionFromHash(hash: string) {
	const value = new URLSearchParams(hash.replace(/^#/, '')).get('session');
	return value ? decodeOAuthSession(value) : null;
}

export function getSafeReturnTo(value: string | null | undefined) {
	if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\'))
		return '/';

	const pathname = value.split(/[?#]/, 1)[0];
	return pathname === '/login' || pathname.startsWith('/auth/') ? '/' : value;
}

export function createLoginPath(returnTo: string) {
	const searchParams = new URLSearchParams({
		returnTo: getSafeReturnTo(returnTo),
	});
	return `/login?${searchParams}`;
}

export function createGoogleLoginUrl({
	apiUrl,
	appOrigin,
	returnTo,
}: {
	apiUrl: string;
	appOrigin: string;
	returnTo: string;
}) {
	const callbackUrl = new URL('/auth/callback', appOrigin);
	callbackUrl.searchParams.set('returnTo', getSafeReturnTo(returnTo));

	const loginUrl = new URL('/auth/google/login', apiUrl);
	loginUrl.searchParams.set('redirect', callbackUrl.href);
	return loginUrl.href;
}
