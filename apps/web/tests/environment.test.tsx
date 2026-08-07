import { env } from '@web/lib/env';
import { describe, expect, it } from 'vitest';

describe('Application environment', () => {
	it('defaults to production when VITE_ENV is not configured', () => {
		expect(env.VITE_ENV).toBe('production');
	});
});
