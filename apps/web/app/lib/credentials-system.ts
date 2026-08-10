import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import { type AppSystem, matchesCommandQuery } from '@web/lib/app-systems';
import {
	credentialsSnapshot,
	useCredentialsStore,
} from '@web/lib/credentials-store';
import { KeyRoundIcon } from 'lucide-react';

const CREDENTIALS_PATH = '/credentials';

function credentialsPath(params: Record<string, string>) {
	return `${CREDENTIALS_PATH}?${new URLSearchParams(params).toString()}`;
}

export const credentialsSystem: AppSystem = {
	key: 'credentials',
	heading: 'Credentials',
	icon: KeyRoundIcon,

	/**
	 * Credentials keep no local database, so nothing the shell watches would ever
	 * tell it these commands changed. The store reports for itself instead.
	 */
	subscribe: (onChange) => useCredentialsStore.subscribe(onChange),

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
				to: credentialsPath({ credential: credential.id }),
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
