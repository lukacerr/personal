import {
	createSessionWorkGuard,
	resumeSessionWork,
	suspendSessionWork,
} from '@web/lib/session-work';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => resumeSessionWork());

describe('session-scoped background work', () => {
	it('invalidates existing work and blocks new work while sign-out clears data', () => {
		const startedBeforeSignOut = createSessionWorkGuard();
		expect(startedBeforeSignOut?.()).toBe(true);

		suspendSessionWork();

		expect(startedBeforeSignOut?.()).toBe(false);
		expect(createSessionWorkGuard()).toBeUndefined();
	});

	it('allows only the new session after authentication resumes', () => {
		const oldSession = createSessionWorkGuard();
		suspendSessionWork();
		resumeSessionWork();
		const newSession = createSessionWorkGuard();

		expect(oldSession?.()).toBe(false);
		expect(newSession?.()).toBe(true);
	});
});
