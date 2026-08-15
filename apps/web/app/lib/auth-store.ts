import { api, isTransientApiFailure } from '@web/lib/api';
import { env } from '@web/lib/env';
import type { SessionTokens } from '@web/lib/session';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type AuthStatus = 'booting' | 'authenticated' | 'unauthenticated';

const AUTH_STORAGE_KEY = 'personal-auth:v1';

/**
 * The refresh token as it was last persisted — by any tab, PWA window or
 * shell. Refresh rotates the token, and the contexts share one storage entry
 * but not one memory: after a twin rotates, the in-memory copy here is the
 * dead predecessor and only storage knows the live token.
 */
function readPersistedRefreshToken() {
	try {
		const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
		if (!raw) return null;
		const envelope = JSON.parse(raw) as {
			state?: { refreshToken?: unknown };
		} | null;
		const refreshToken = envelope?.state?.refreshToken;
		return typeof refreshToken === 'string' ? refreshToken : null;
	} catch {
		return null;
	}
}

type PersistedAuthState = Pick<AuthState, 'refreshToken'>;

type AuthState = {
	accessToken: string | null;
	refreshToken: string | null;
	status: AuthStatus;
	setSession: (tokens: SessionTokens) => void;
	clearSession: () => void;
	refreshSession: () => Promise<string | null>;
	bootstrap: () => Promise<void>;
};

export function getPersistedAuthState({
	refreshToken,
}: Pick<AuthState, 'accessToken' | 'refreshToken' | 'status'>) {
	return { refreshToken };
}

export const useAuthStore = create<AuthState>()(
	persist<AuthState, [], [], PersistedAuthState>(
		(set, get) => ({
			accessToken: null,
			refreshToken: null,
			status: 'booting',
			setSession: ({ at, rt }) =>
				set({
					accessToken: at,
					refreshToken: rt,
					status: 'authenticated',
				}),
			clearSession: () =>
				set({
					accessToken: null,
					refreshToken: null,
					status: 'unauthenticated',
				}),
			refreshSession: async () => {
				// Prefer the persisted token: a twin tab that refreshed after this
				// one loaded already rotated it, and sending the stale copy would
				// fail against a session that is perfectly alive.
				const refreshToken = readPersistedRefreshToken() ?? get().refreshToken;
				if (!refreshToken) return null;
				if (refreshToken !== get().refreshToken) set({ refreshToken });

				const { data, error } = await api.auth['refresh-token'].post({
					refreshToken,
				});
				if (error) {
					if (isTransientApiFailure(error.status)) throw error;

					// A rotation may have landed while this request was in flight. If
					// storage no longer holds the token that just failed, another tab
					// owns a live session: adopt its token and retry instead of
					// clearing — clearing would persist the wipe and destroy it.
					const persisted = readPersistedRefreshToken();
					if (persisted && persisted !== refreshToken) {
						set({ refreshToken: persisted, accessToken: null });
						return get().refreshSession();
					}

					get().clearSession();
					return null;
				}

				get().setSession(data);
				return data.at;
			},
			bootstrap: async () => {
				if (env.VITE_ENV === 'development') {
					set({ accessToken: 'dev', status: 'authenticated' });
					return;
				}

				await useAuthStore.persist.rehydrate();
				if (!get().refreshToken) {
					get().clearSession();
					return;
				}

				try {
					await get().refreshSession();
				} catch {
					set({ accessToken: null, status: 'authenticated' });
				}
			},
		}),
		{
			name: AUTH_STORAGE_KEY,
			storage: createJSONStorage(() => window.localStorage),
			partialize: getPersistedAuthState,
			skipHydration: true,
			version: 1,
		},
	),
);
