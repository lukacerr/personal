import type { Credential } from '@web/lib/credentials-api';
import { decryptCredentialValue } from '@web/lib/credentials-crypto';
import { isBareLetterShortcut, type ShortcutEvent } from '@web/lib/keyboard';

/** The bare letter opens the create form; Ctrl/Cmd+A stays select all. */
export function isAddCredentialShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'a');
}

/** The bare letter mirrors the toolbar's Reveal all / Hide all; Ctrl+R reloads. */
export function isToggleRevealShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'r');
}

/**
 * The bare letter copies the credential the URL points at — the one the
 * palette or a shared link selected. With nothing selected there is nothing
 * unambiguous to copy, so the screen only claims the key when `?credential=`
 * names a row. Ctrl/Cmd+C stays copy.
 */
export function isCopyCredentialShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'c');
}

/**
 * A fixed-width mask, not one that follows the value.
 *
 * `'•'.repeat(value.length)` would publish the length of every secret to anyone
 * glancing at the screen, and for a card or a PIN the length is most of the
 * guess. This says "there is something here" and nothing else.
 */
export const CREDENTIAL_MASK = '••••••••••••';

/**
 * What a credential's value can be showing.
 *
 * `unreadable` is nearly unreachable in practice: the API decrypts every envelope
 * before storing it, so anything that got in can be read back with the secret it
 * holds. It exists so the UI never has to pretend an empty value is a real one.
 */
export type CredentialValueState =
	| { state: 'locked' }
	| { state: 'readable'; value: string }
	| { state: 'unreadable' };

/**
 * `readable` rather than `revealed`: whether a value *can* be read is a different
 * question from whether the eye is currently showing it, and one screen asks both.
 */
export async function readCredentialValue(
	credential: Pick<Credential, 'value'>,
	secret: string | undefined,
): Promise<CredentialValueState> {
	if (!secret) return { state: 'locked' };
	const decrypted = await decryptCredentialValue(credential.value, secret);
	return decrypted.ok
		? { state: 'readable', value: decrypted.value }
		: { state: 'unreadable' };
}

/**
 * Whether a secret someone just typed is the one these credentials were sealed
 * with, decided by opening one of them.
 *
 * With nothing stored yet there is nothing to check against, so the secret is
 * accepted: the first write will be validated by the API, which is the right
 * place for it to fail. Checking against a single credential is enough — they all
 * share one secret, and a mismatch on one is a mismatch on all.
 */
export async function verifyCredentialsSecret(
	secret: string,
	credentials: Array<Pick<Credential, 'value'>>,
) {
	const sample = credentials.at(0);
	if (!sample) return true;
	return (await decryptCredentialValue(sample.value, secret)).ok;
}

export type CredentialsView = {
	query: string;
	/** The credential the palette or a shared link asked to bring into view. */
	selected: string | null;
};

export function parseCredentialsView(params: URLSearchParams): CredentialsView {
	return {
		query: params.get('q')?.trim() ?? '',
		selected: params.get('credential') || null,
	};
}

type CredentialsViewPatch = Partial<{ query: string; selected: string | null }>;

/** Changes one concern without throwing away the rest of the shareable view. */
export function updateCredentialsSearchParams(
	current: URLSearchParams,
	patch: CredentialsViewPatch,
) {
	const next = new URLSearchParams(current);
	const values: Array<[keyof CredentialsViewPatch, string, string | null]> = [
		['query', 'q', patch.query ?? null],
		['selected', 'credential', patch.selected ?? null],
	];

	for (const [field, parameter, value] of values) {
		if (!(field in patch)) continue;
		// Defaults are dropped rather than spelled out, so a plain visit keeps a
		// plain URL.
		if (value === null || value === '') next.delete(parameter);
		else next.set(parameter, value);
	}
	return next;
}

export function filterCredentials(credentials: Credential[], query: string) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return credentials;
	// The title is the only searchable thing a credential has: the value is
	// ciphertext until someone unlocks it, and searching decrypted values would
	// mean decrypting every row on every keystroke.
	return credentials.filter((credential) =>
		credential.title.toLocaleLowerCase().includes(needle),
	);
}
