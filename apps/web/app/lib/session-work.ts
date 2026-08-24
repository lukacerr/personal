export type SessionWorkGuard = () => boolean;

let generation = 0;
let acceptingWork = true;

/** Captures the current authenticated session for asynchronous background work. */
export function createSessionWorkGuard(): SessionWorkGuard | undefined {
	if (!acceptingWork) return undefined;
	const startedIn = generation;
	return () => acceptingWork && generation === startedIn;
}

/** Invalidates in-flight work before sign-out starts erasing local data. */
export function suspendSessionWork() {
	if (!acceptingWork) return;
	acceptingWork = false;
	generation += 1;
}

/** Opens a new generation after authentication succeeds. */
export function resumeSessionWork() {
	if (acceptingWork) return;
	acceptingWork = true;
}
