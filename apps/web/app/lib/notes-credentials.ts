/**
 * A note can point at a credential. The block holds the id and the title, and
 * never the value: props are serialised verbatim into the note document, into
 * every history version, into every delta, and into the payload a published note
 * hands to anyone with the link.
 *
 * The prop is `credentialId` rather than `fileId` on purpose. `GET
 * /files/unreferenced` asks Postgres for `$.**.props.fileId` across every block
 * type, so a credential block carrying that name would make files look
 * referenced by a block that has nothing to do with them.
 */
export const CREDENTIAL_BLOCK_TYPE = 'credential';

/**
 * What the block can be showing.
 *
 * `locked` and `unreadable` are different failures worth telling apart: the first
 * is a secret nobody has typed yet, the second a value this secret cannot open.
 * `unavailable` is the public page, where a credential is never resolved at all.
 */
export type CredentialBlockState =
	| 'empty'
	| 'loading'
	| 'locked'
	| 'ready'
	| 'unreadable'
	| 'missing'
	| 'unavailable'
	| 'failed';
