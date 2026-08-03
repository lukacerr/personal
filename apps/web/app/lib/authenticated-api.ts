import type { App } from '@api';
import { treaty } from '@elysia/eden';
import { useAuthStore } from '@web/lib/auth-store';
import { createAuthenticatedFetch } from '@web/lib/authenticated-fetch';
import { env } from '@web/lib/env';

export const authenticatedApi = treaty<App>(env.VITE_API_URL, {
	fetcher: createAuthenticatedFetch({
		fetcher: globalThis.fetch,
		getAccessToken: () => useAuthStore.getState().accessToken,
		refreshAccessToken: () => useAuthStore.getState().refreshSession(),
		onUnauthorized: () => useAuthStore.getState().clearSession(),
	}) as typeof fetch,
});
