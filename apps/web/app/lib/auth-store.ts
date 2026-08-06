import { api, isTransientApiFailure } from '@web/lib/api';
import { env } from '@web/lib/env';
import type { SessionTokens } from '@web/lib/session';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type AuthStatus = 'booting' | 'authenticated' | 'unauthenticated';

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
				const { refreshToken } = get();
				if (!refreshToken) return null;

				const { data, error } = await api.auth['refresh-token'].post({
					refreshToken,
				});
				if (error) {
					if (isTransientApiFailure(error.status)) throw error;

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
			name: 'personal-auth:v1',
			storage: createJSONStorage(() => window.localStorage),
			partialize: getPersistedAuthState,
			skipHydration: true,
			version: 1,
		},
	),
);
