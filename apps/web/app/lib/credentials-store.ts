import { type Credential, listCredentials } from '@web/lib/credentials-api';
import { create } from 'zustand';

type CredentialsStatus = 'idle' | 'loading' | 'ready' | 'failed';

type CredentialsState = {
	credentials: Credential[];
	status: CredentialsStatus;
	error?: string;
	/** What the server called the copy held here, so a refresh can ask for less. */
	tag?: string;
	/** Fetches the index unless it is already there; `force` refreshes it. */
	load: (force?: boolean) => Promise<void>;
	upsert: (credentials: Credential[]) => void;
	remove: (ids: string[]) => void;
};

/**
 * The one copy of the credential index the app keeps.
 *
 * Credentials are not local-first: the API is the source, and nothing here is
 * ever written to a local database. Everything in this list is still encrypted —
 * decryption happens where a value is actually shown — so holding it costs
 * nothing in exposure.
 *
 * Three places need the same list: the screen, the credential block in a note and
 * the command palette. Fetching it three times would be three answers that
 * disagree the moment one of them writes.
 */
export const useCredentialsStore = create<CredentialsState>()((set, get) => {
	// Concurrent callers share one request rather than racing to overwrite each
	// other, the same way Storage coalesces its index.
	let inFlight: Promise<void> | undefined;

	return {
		credentials: [],
		status: 'idle',

		async load(force = false) {
			if (inFlight) return inFlight;
			if (!force && get().status === 'ready') return;

			set({ status: 'loading' });
			inFlight = (async () => {
				try {
					const answer = await listCredentials(get().tag);
					if (answer === 'unchanged')
						set({ status: 'ready', error: undefined });
					else
						set({
							credentials: answer.credentials,
							tag: answer.tag,
							status: 'ready',
							error: undefined,
						});
				} catch {
					set({
						status: 'failed',
						error: navigator.onLine
							? 'Your credentials could not be loaded. Try again in a moment.'
							: 'No connection. Credentials need to reach the server.',
					});
				} finally {
					inFlight = undefined;
				}
			})();
			return inFlight;
		},

		upsert: (updated) => {
			const byId = new Map(updated.map((entry) => [entry.id, entry]));
			// The tag describes what the server sent, and this is no longer that.
			set(({ credentials }) => {
				const merged = credentials.map((entry) => byId.get(entry.id) ?? entry);
				const known = new Set(credentials.map((entry) => entry.id));
				return {
					tag: undefined,
					credentials: [
						...merged,
						...updated.filter((entry) => !known.has(entry.id)),
					],
				};
			});
		},

		remove: (ids) => {
			const dropped = new Set(ids);
			set(({ credentials }) => ({
				tag: undefined,
				credentials: credentials.filter((entry) => !dropped.has(entry.id)),
			}));
		},
	};
});

/** Reads the index without subscribing, for the system registry's loaders. */
export const credentialsSnapshot = () => useCredentialsStore.getState();
