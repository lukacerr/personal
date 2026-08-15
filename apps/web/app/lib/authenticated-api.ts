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
	/**
	 * Eden's reviver runs over every string in every response and would turn
	 * anything date-shaped into a `Date` the contract never declared: Calendar's
	 * local `YYYY-MM-DD` days, or even a note titled `2026-01-01`. Timestamps
	 * here are epoch numbers by convention, so nothing legitimate loses out.
	 */
	parseDate: false,
});
