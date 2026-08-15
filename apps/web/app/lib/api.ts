import type { App } from '@api';
import { treaty } from '@elysia/eden';
import { env } from '@web/lib/env';

// `parseDate: false` for the same reason as `authenticatedApi`: the reviver
// would turn any date-shaped string — a Calendar day, a note titled
// `2026-01-01` — into a `Date` the contract never declared.
export const api = treaty<App>(env.VITE_API_URL, { parseDate: false });

/**
 * A failure retrying can fix: the network itself (status 0), the server (5xx),
 * a timeout (408) or a rate limit (429). Every other 4xx will fail identically
 * on every retry, so callers treat it as terminal — dropping the operation or
 * clearing the session instead of retrying forever.
 *
 * This is the one canonical reading of transient-vs-terminal. Do not redeclare
 * it: a copy that forgot 429 once signed the session out for being briefly
 * rate limited.
 */
export function isTransientApiFailure(status: number) {
	return status === 0 || status >= 500 || status === 408 || status === 429;
}
