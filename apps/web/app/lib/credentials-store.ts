import { type Credential, listCredentials } from '@web/lib/credentials-api';
import {
	createIndexCore,
	type IndexCore,
	type IndexLoadOutcome,
} from '@web/lib/index-store';
import type { SessionWorkGuard } from '@web/lib/session-work';
import { create } from 'zustand';

type CredentialsState = IndexCore & {
	credentials: Credential[];
	/** Fetches the index unless it is already there; `force` refreshes it. */
	load: (
		force?: boolean,
		isCurrent?: SessionWorkGuard,
	) => Promise<IndexLoadOutcome>;
	reset: () => void;
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
export const useCredentialsStore = create<CredentialsState>()((set, get) => ({
	credentials: [],
	...createIndexCore<CredentialsState, Credential>({
		get,
		patch: ({ items, ...core }) =>
			set(items ? { ...core, credentials: items } : core),
		read: async (knownTag) => {
			const answer = await listCredentials(knownTag);
			return answer === 'unchanged'
				? answer
				: { items: answer.credentials, tag: answer.tag };
		},
		select: (state) => state.credentials,
		failure: {
			unreachable:
				'Your credentials could not be loaded. Try again in a moment.',
			offline: 'No connection. Credentials need to reach the server.',
		},
	}),
}));

/** Reads the index without subscribing, for the system registry's loaders. */
export const credentialsSnapshot = () => useCredentialsStore.getState();
