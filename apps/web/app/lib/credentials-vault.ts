import {
	type CredentialValueState,
	readCredentialValue,
} from '@web/lib/credentials';
import {
	type Credential,
	createCredential,
	deleteCredential,
	isRejectedEnvelope,
	isTitleTaken,
	updateCredential,
} from '@web/lib/credentials-api';
import { encryptCredentialValue } from '@web/lib/credentials-crypto';
import { useCredentialsSecretStore } from '@web/lib/credentials-secret';
import { useCredentialsStore } from '@web/lib/credentials-store';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Every operation the Credentials screen and the note block perform.
 *
 * The store owns the index; this owns what to do with it, the same split Storage
 * uses. Mutations answer with a message rather than throwing: every caller is a
 * dialog with a place to put one, and a toast is the wrong shape for a condition
 * that is still true after it fades.
 */

function saveFailure(error: unknown) {
	if (isTitleTaken(error))
		return 'A credential with this title already exists.';
	// The API decrypts before it stores, so a rejected envelope means one thing:
	// the secret held here is not the one the server has.
	if (isRejectedEnvelope(error))
		return 'The server could not read this value. The secret saved on this device is not the one it uses.';
	return navigator.onLine
		? 'The server rejected this change.'
		: 'Saving a credential requires a connection.';
}

export function useCredentials() {
	const credentials = useCredentialsStore((state) => state.credentials);
	const status = useCredentialsStore((state) => state.status);
	const loadError = useCredentialsStore((state) => state.error);
	const load = useCredentialsStore((state) => state.load);
	const upsert = useCredentialsStore((state) => state.upsert);
	const drop = useCredentialsStore((state) => state.remove);

	const secret = useCredentialsSecretStore((state) => state.secret);
	const unlock = useCredentialsSecretStore((state) => state.unlock);
	const forget = useCredentialsSecretStore((state) => state.forget);

	useEffect(() => {
		void load();
	}, [load]);

	// A refresh that fails when there is already a list on screen says so and
	// leaves the list alone. Replacing rows the user can still copy from with a
	// full-screen error loses more than the failure cost them.
	useEffect(() => {
		if (status === 'failed' && credentials.length > 0 && loadError)
			toast.error(loadError);
	}, [credentials.length, loadError, status]);

	const [values, setValues] = useState<Map<string, CredentialValueState>>(
		() => new Map(),
	);

	/**
	 * Every value is decrypted as soon as there is a secret, not when a row is
	 * first looked at: the derivation is microseconds, and doing it up front is
	 * what lets the eye toggle be instant and the copy button never await.
	 */
	useEffect(() => {
		if (!secret) {
			setValues(new Map());
			return;
		}

		let current = true;
		void (async () => {
			const entries = await Promise.all(
				credentials.map(
					async (credential) =>
						[
							credential.id,
							await readCredentialValue(credential, secret),
						] as const,
				),
			);
			if (current) setValues(new Map(entries));
		})();
		return () => {
			current = false;
		};
	}, [credentials, secret]);

	/**
	 * Encrypting here is what keeps the plaintext off the wire: the API only ever
	 * proves the envelope opens, and never sees what is inside it. Creating needs
	 * a secret for exactly that reason, which is why it is a separate call from
	 * updating — where omitting the value is the whole point.
	 */
	const create = useCallback(
		async (title: string, plaintext: string) => {
			if (!secret) return 'Unlock the vault before adding a credential.';
			try {
				upsert([
					await createCredential(
						title,
						await encryptCredentialValue(plaintext, secret),
					),
				]);
				return undefined;
			} catch (error) {
				return saveFailure(error);
			}
		},
		[secret, upsert],
	);

	/**
	 * `plaintext` left out keeps the stored ciphertext, which is what makes
	 * renaming work with no secret at all.
	 */
	const update = useCallback(
		async (
			credential: Credential,
			changes: { title: string; plaintext?: string },
		) => {
			if (changes.plaintext !== undefined && !secret)
				return 'Unlock the vault before changing a value.';
			try {
				const value =
					changes.plaintext === undefined || !secret
						? undefined
						: await encryptCredentialValue(changes.plaintext, secret);
				upsert([
					await updateCredential(credential.id, {
						title: changes.title,
						value,
					}),
				]);
				return undefined;
			} catch (error) {
				return saveFailure(error);
			}
		},
		[secret, upsert],
	);

	const remove = useCallback(
		async (credential: Credential) => {
			try {
				await deleteCredential(credential.id);
				drop([credential.id]);
				return undefined;
			} catch {
				return navigator.onLine
					? 'That credential could not be deleted.'
					: 'Deleting a credential requires a connection.';
			}
		},
		[drop],
	);

	const copy = useCallback(
		async (credential: Credential) => {
			const value = values.get(credential.id);
			if (value?.state !== 'readable') return;
			try {
				await navigator.clipboard.writeText(value.value);
				toast.success(`“${credential.title}” copied.`);
			} catch {
				// A clipboard the browser refuses is worth saying out loud: the user is
				// otherwise left believing they have the value.
				toast.error('This browser would not let the value be copied.');
			}
		},
		[values],
	);

	return {
		credentials,
		values,
		secret,
		unlock,
		forget,
		loading: status === 'loading' && credentials.length === 0,
		/** Only surfaced when there is nothing on screen to fall back to. */
		loadError:
			status === 'failed' && credentials.length === 0 ? loadError : undefined,
		reload: useCallback(() => load(true), [load]),
		create,
		update,
		remove,
		copy,
	};
}
