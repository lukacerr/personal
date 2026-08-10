/**
 * Sealing and opening a credential envelope, entirely in the browser.
 *
 * This is the half of the algorithm that owns the plaintext. A value is encrypted
 * here before it ever reaches the network, and the API only proves on write that
 * what arrived can be decrypted with its copy of the secret — it never sees, logs
 * or stores the plaintext. `apps/api/src/credentials-crypto.ts` is the mirror of
 * this file, decrypt-only, and a shared known-answer vector in both test suites is
 * what keeps the two from drifting apart.
 *
 * The web cannot import runtime code from the API — only the `App` type — so the
 * duplication is structural rather than a shortcut.
 */

const ENVELOPE_VERSION = 'v1';
/** Domain separation for the derived key. Must match the API's copy exactly. */
const KEY_INFO = 'personal:credential:v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type CredentialDecryption =
	| { ok: true; value: string }
	| { ok: false; reason: 'malformed' | 'undecryptable' };

function toBase64Url(bytes: Uint8Array) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

/**
 * `atob` tolerates missing padding but throws on anything outside the alphabet,
 * and the length check is what separates a truncated envelope from a valid one:
 * without it a short salt would decode happily and only fail later, as if the
 * secret were wrong.
 */
function fromBase64Url(
	segment: string,
	bytes?: number,
): Uint8Array<ArrayBuffer> | undefined {
	if (!BASE64URL.test(segment)) return undefined;
	try {
		const binary = atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
		const decoded = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		if (bytes !== undefined && decoded.length !== bytes) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

/**
 * Importing the secret is the only part worth keeping: it depends on the secret
 * alone, where the derived key depends on each record's salt. One entry is
 * enough — there is one secret unlocked at a time.
 */
let importedSecret: { secret: string; material: CryptoKey } | undefined;

async function secretMaterial(secret: string) {
	if (importedSecret?.secret === secret) return importedSecret.material;
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		'HKDF',
		false,
		['deriveKey'],
	);
	importedSecret = { secret, material };
	return material;
}

/**
 * HKDF rather than PBKDF2 because `LUKA_SECRET` is high-entropy key material,
 * not a memorised passphrase. It also costs microseconds, which is what lets
 * every record carry its own salt: PBKDF2 at a defensible iteration count would
 * spend hundreds of milliseconds per row and turn drawing the list into a wait.
 */
async function deriveKey(
	secret: string,
	salt: Uint8Array<ArrayBuffer>,
	usage: 'encrypt' | 'decrypt',
) {
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(KEY_INFO) },
		await secretMaterial(secret),
		{ name: 'AES-GCM', length: 256 },
		false,
		[usage],
	);
}

/**
 * The salt and iv are injectable so the shared test vector can be deterministic.
 * Nothing in the app passes them: a reused iv is the one way to break AES-GCM,
 * and the only safe source is `getRandomValues` on every call.
 */
export async function encryptCredentialValue(
	plaintext: string,
	secret: string,
	fixed?: { salt: Uint8Array; iv: Uint8Array },
) {
	const salt = fixed
		? Uint8Array.from(fixed.salt)
		: crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = fixed
		? Uint8Array.from(fixed.iv)
		: crypto.getRandomValues(new Uint8Array(IV_BYTES));

	const key = await deriveKey(secret, salt, 'encrypt');
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			encoder.encode(plaintext),
		),
	);

	return [
		ENVELOPE_VERSION,
		toBase64Url(salt),
		toBase64Url(iv),
		toBase64Url(ciphertext),
	].join('.');
}

export async function decryptCredentialValue(
	raw: string,
	secret: string,
): Promise<CredentialDecryption> {
	const segments = raw.split('.');
	if (segments.length !== 4 || segments[0] !== ENVELOPE_VERSION)
		return { ok: false, reason: 'malformed' };

	const salt = fromBase64Url(segments[1], SALT_BYTES);
	const iv = fromBase64Url(segments[2], IV_BYTES);
	const ciphertext = fromBase64Url(segments[3]);
	if (!salt || !iv || !ciphertext) return { ok: false, reason: 'malformed' };

	try {
		const key = await deriveKey(secret, salt, 'decrypt');
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext,
		);
		return { ok: true, value: decoder.decode(plaintext) };
	} catch {
		return { ok: false, reason: 'undecryptable' };
	}
}
