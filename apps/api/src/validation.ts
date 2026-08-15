import { z } from 'zod';

/** Largest instant `Date` can represent, so a timestamp never becomes `Invalid Date`. */
export const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;

/** How far ahead of the server an honest client clock is allowed to claim to be. */
export const MAX_CLOCK_SKEW_MS = 48 * 60 * 60 * 1000;

/**
 * A user-chosen instant: when an expense happened, when a subscription ends,
 * where a statement period closes. The future is legitimate here — the current
 * month's range ends next month — so the only bound is what `Date` can hold.
 */
export const dateTimestampMs = z
	.number()
	.int()
	.nonnegative()
	.max(TIMESTAMP_MAX_MS);

/**
 * A client edit clock, as used by last-write-wins resolution and version
 * history. Bounded to a small skew past the server's now — evaluated per
 * request, never when the module loads — because a clock from the far future
 * would out-rank every honest edit permanently, leaving the record uneditable.
 */
export const timestampMs = dateTimestampMs.refine(
	(value) => value <= Date.now() + MAX_CLOCK_SKEW_MS,
	'Timestamp is further ahead than clock skew can explain',
);
