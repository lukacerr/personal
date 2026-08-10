import { z } from 'zod';
import { create } from 'zustand';

/**
 * The secret that opens every credential, and where it is kept.
 *
 * It lives in `localStorage` because the alternative is retyping it on every
 * reload, and the device this runs on is trusted by decision. It never reaches
 * the API, never appears in a URL, and never becomes a prop of a Notes block —
 * the API has its own copy from the environment and needs nothing from here.
 *
 * A Zustand store rather than a hook: the Credentials screen and the credential
 * block inside a note live in different trees and must see the same value change
 * at the same time, and the system registry reads it without subscribing.
 */

export const CREDENTIALS_SECRET_KEY = 'personal-credentials-secret:v1';

const storedSecretSchema = z.object({
	version: z.literal(1),
	secret: z.string().min(1),
});

export function loadCredentialsSecret(storage: Pick<Storage, 'getItem'>) {
	try {
		const raw = storage.getItem(CREDENTIALS_SECRET_KEY);
		if (!raw) return undefined;
		const parsed = storedSecretSchema.safeParse(JSON.parse(raw));
		// Anything unreadable leaves the app locked. Treating a broken value as a
		// secret would show a screen of rows that all fail to decrypt, and blame
		// the data for what is really a bad entry.
		return parsed.success ? parsed.data.secret : undefined;
	} catch {
		return undefined;
	}
}

export function saveCredentialsSecret(
	storage: Pick<Storage, 'setItem'>,
	secret: string,
) {
	try {
		storage.setItem(
			CREDENTIALS_SECRET_KEY,
			JSON.stringify({ version: 1, secret }),
		);
	} catch {
		// Persistence is best-effort when storage is full or blocked; the secret is
		// still usable for this session.
	}
}

export function clearCredentialsSecret(storage: Pick<Storage, 'removeItem'>) {
	try {
		storage.removeItem(CREDENTIALS_SECRET_KEY);
	} catch {
		// Nothing to do: the in-memory secret is dropped either way.
	}
}

type CredentialsSecretState = {
	/** Absent means locked. There is no third state worth modelling. */
	secret?: string;
	unlock: (secret: string) => void;
	forget: () => void;
};

export const useCredentialsSecretStore = create<CredentialsSecretState>()(
	(set) => ({
		secret:
			typeof window === 'undefined'
				? undefined
				: loadCredentialsSecret(window.localStorage),

		unlock: (secret) => {
			saveCredentialsSecret(window.localStorage, secret);
			set({ secret });
		},

		forget: () => {
			clearCredentialsSecret(window.localStorage);
			set({ secret: undefined });
		},
	}),
);

/** Reads the secret without subscribing, for callers outside React. */
export const credentialsSecretSnapshot = () =>
	useCredentialsSecretStore.getState().secret;
