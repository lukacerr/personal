/**
 * Reading a credential envelope, so the API can prove one is legible.
 *
 * The API never encrypts and never stores a plaintext value: the client does
 * that with its own copy of the secret, and what arrives here is already an
 * envelope. What this module exists for is the write-time check — decrypt it
 * once, confirm it can be read, and throw the plaintext away. Without that a
 * client bug or a stale secret would write a row nobody can ever read, and the
 * loss would only surface months later when someone needed the value.
 *
 * Implemented against WebCrypto rather than `node:crypto` on purpose: the web
 * half of this algorithm has no choice, and keeping both sides on the same API
 * is what makes the shared test vector a real comparison instead of a
 * coincidence. Nothing here is allowed to throw — every caller is an HTTP
 * handler that owes the client a status code.
 */

const ENVELOPE_VERSION = 'v1';
/** Domain separation for the derived key. Must match the web's copy exactly. */
const KEY_INFO = 'personal:credential:v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
/**
 * `Buffer.from(value, 'base64url')` silently ignores anything it does not
 * recognise, so a segment is checked before it is decoded. Skipping this makes
 * a string that is not an envelope at all look merely undecryptable.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The byte arrays are pinned to `ArrayBuffer` rather than left as the default
 * `ArrayBufferLike`. The web reaches this file through the `App` type it imports
 * from `@api`, and under its DOM lib a `BufferSource` must be backed by an
 * `ArrayBuffer` — a `SharedArrayBuffer` is not assignable. Without the parameter
 * the API typechecks alone and the web fails on a file it never runs.
 */
type CredentialEnvelope = {
	salt: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
};

export type CredentialDecryption =
	| { ok: true; value: string }
	| { ok: false; reason: 'malformed' | 'undecryptable' };

function decodeSegment(
	segment: string,
	bytes?: number,
): Uint8Array<ArrayBuffer> | undefined {
	if (!BASE64URL.test(segment)) return undefined;
	const decoded = Uint8Array.from(Buffer.from(segment, 'base64url'));
	if (bytes !== undefined && decoded.length !== bytes) return undefined;
	return decoded;
}

function parseEnvelope(raw: string): CredentialEnvelope | undefined {
	const segments = raw.split('.');
	if (segments.length !== 4) return undefined;

	const [version, rawSalt, rawIv, rawCiphertext] = segments;
	if (version !== ENVELOPE_VERSION) return undefined;

	const salt = decodeSegment(rawSalt, SALT_BYTES);
	const iv = decodeSegment(rawIv, IV_BYTES);
	const ciphertext = decodeSegment(rawCiphertext);
	if (!salt || !iv || !ciphertext) return undefined;

	return { salt, iv, ciphertext };
}

/**
 * HKDF rather than PBKDF2 because `LUKA_SECRET` is high-entropy key material,
 * not a memorised passphrase. It is also cheap enough that a per-record salt
 * costs nothing, where PBKDF2 at a defensible iteration count would force the
 * client to spend hundreds of milliseconds per row just to draw a list.
 */
async function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>) {
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		'HKDF',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(KEY_INFO) },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['decrypt'],
	);
}

/**
 * A wrong secret and a tampered ciphertext are indistinguishable here — both are
 * an authentication tag that does not verify — and that is fine: the caller only
 * needs to know the value cannot be trusted, not which of the two happened.
 */
export async function decryptCredentialValue(
	raw: string,
	secret: string,
): Promise<CredentialDecryption> {
	const envelope = parseEnvelope(raw);
	if (!envelope) return { ok: false, reason: 'malformed' };

	try {
		const key = await deriveKey(secret, envelope.salt);
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: envelope.iv },
			key,
			envelope.ciphertext,
		);
		return { ok: true, value: decoder.decode(plaintext) };
	} catch {
		return { ok: false, reason: 'undecryptable' };
	}
}
