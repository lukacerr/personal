import type { App } from '@api';
import { treaty } from '@elysia/eden';
import { env } from '@web/lib/env';

// `parseDate: false` for the same reason as `authenticatedApi`: the reviver
// would turn any date-shaped string — a Calendar day, a note titled
// `2026-01-01` — into a `Date` the contract never declared.
export const api = treaty<App>(env.VITE_API_URL, { parseDate: false });

export function isTransientApiFailure(status: number) {
	return status >= 500;
}
