import { authenticatedApi } from '@web/lib/authenticated-api';
import { conditionalGet } from '@web/lib/http-conditional';
import type { TreatyData } from '@web/lib/treaty-data';

type Credentials = Extract<
	TreatyData<typeof authenticatedApi.credentials.get>,
	unknown[]
>;

/** The contract itself, never a hand-written copy of it. */
export type Credential = Credentials[number];

export class CredentialsApiError extends Error {
	constructor(readonly status: number) {
		super(`Credentials API returned ${status}`);
	}
}

/** The server refused the envelope: this secret is not the one it holds. */
export const isRejectedEnvelope = (error: unknown) =>
	error instanceof CredentialsApiError && error.status === 422;

export const isTitleTaken = (error: unknown) =>
	error instanceof CredentialsApiError && error.status === 409;

/** Whether the reply is one credential rather than an error shape. */
function asCredential(data: unknown, status: number) {
	if (status < 200 || status >= 300 || !data || !('title' in (data as object)))
		throw new CredentialsApiError(status);
	return data as Credential;
}

/**
 * The index, or word that the copy already held is still current.
 *
 * Values arrive encrypted and stay that way until something on screen asks for
 * one, so this list is safe to hold in memory and cheap to revalidate.
 */
export function listCredentials(
	knownTag?: string,
): Promise<{ credentials: Credential[]; tag?: string } | 'unchanged'> {
	return conditionalGet(
		knownTag,
		(conditional) => authenticatedApi.credentials.get(conditional),
		(response) => {
			if (response.status !== 200 || !Array.isArray(response.data))
				throw new CredentialsApiError(response.status);
			return { credentials: response.data };
		},
	);
}

export async function createCredential(title: string, value: string) {
	const response = await authenticatedApi.credentials.post({ title, value });
	return asCredential(response.data, response.status);
}

/**
 * Omitting `value` leaves the stored ciphertext alone, which is what makes
 * renaming possible while the app is locked.
 */
export async function updateCredential(
	id: string,
	changes: { title: string; value?: string },
) {
	const response = await authenticatedApi.credentials({ id }).patch(changes);
	return asCredential(response.data, response.status);
}

export async function deleteCredential(id: string) {
	const response = await authenticatedApi.credentials({ id }).delete();
	if (response.status !== 204) throw new CredentialsApiError(response.status);
}
