import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import {
	type AppSystem,
	matchesCommandQuery,
	refreshIndexStore,
	systemPath,
} from '@web/lib/app-systems';
import { useCredentialsSecretStore } from '@web/lib/credentials-secret';
import {
	credentialsSnapshot,
	useCredentialsStore,
} from '@web/lib/credentials-store';
import { KeyRoundIcon } from 'lucide-react';

const CREDENTIALS_PATH = '/credentials';

export const credentialsSystem: AppSystem = {
	key: 'credentials',
	heading: 'Credentials',
	icon: KeyRoundIcon,
	/**
	 * The index is only ciphertext; the master secret is what opens it, and it
	 * outlives a reload in `localStorage`. Sign-out on a device being handed back
	 * has to take it — and the key material imported from it — with the rows,
	 * otherwise anything the API will serve next is still readable.
	 */
	clearLocalData: () => {
		useCredentialsSecretStore.getState().forget();
		useCredentialsStore.getState().reset();
	},

	/**
	 * Credentials keep no local database, so nothing the shell watches would ever
	 * tell it these commands changed. The store reports for itself instead —
	 * only when the rows themselves move: the shell re-runs every system's
	 * loaders on each report, and a status flip changes nothing it can show.
	 */
	subscribe: (onChange) =>
		useCredentialsStore.subscribe((state, previous) => {
			if (state.credentials !== previous.credentials) onChange();
		}),

	/** Still ciphertext: refreshing the index decrypts nothing. */
	refresh: refreshIndexStore(useCredentialsStore),

	/**
	 * The index is fetched the first time somebody actually searches, not when the
	 * shell mounts. Titles are the only thing offered here: a value is ciphertext
	 * until someone unlocks it, and a command palette is the last place that should
	 * be decrypting secrets.
	 */
	async searchCommands(query, limit) {
		const { credentials, status, load } = credentialsSnapshot();
		if (status === 'idle') void load();

		return credentials
			.filter((credential) => matchesCommandQuery(query, credential.title))
			.slice(0, limit)
			.map((credential) => ({
				id: credential.id,
				label: credential.title,
				to: systemPath(CREDENTIALS_PATH, { credential: credential.id }),
			}));
	},

	async loadBreadcrumbTrail(pathname, search): Promise<AppBreadcrumbItem[]> {
		if (pathname !== CREDENTIALS_PATH) return [];
		const selected = new URLSearchParams(search).get('credential');
		if (!selected) return [];

		const title = credentialsSnapshot().credentials.find(
			(credential) => credential.id === selected,
		)?.title;
		return title
			? [{ key: 'credential', label: title, icon: KeyRoundIcon }]
			: [];
	},
};
