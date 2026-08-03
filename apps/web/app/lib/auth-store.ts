import { api } from '@web/lib/api';
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

				try {
					const { data, error } = await api.auth['refresh-token'].post({
						refreshToken,
					});
					if (error) {
						get().clearSession();
						return null;
					}

					get().setSession(data);
					return data.at;
				} catch {
					get().clearSession();
					return null;
				}
			},
			bootstrap: async () => {
				await useAuthStore.persist.rehydrate();
				if (!get().refreshToken) {
					get().clearSession();
					return;
				}

				await get().refreshSession();
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
