import { isTransientApiFailure } from '@web/lib/api';
import { registerServiceWorker } from '@web/lib/register-service-worker';
import { describe, expect, it, vi } from 'vitest';

describe('Offline app shell', () => {
	it('keeps authentication through transient API failures', () => {
		expect(isTransientApiFailure(503)).toBe(true);
		expect(isTransientApiFailure(401)).toBe(false);
	});

	it('registers the service worker and checks for updates', async () => {
		const update = vi.fn(async () => undefined);
		const register = vi.fn(async () => ({ update }));

		await registerServiceWorker({ register });

		expect(register).toHaveBeenCalledWith('/sw.js');
		expect(update).toHaveBeenCalledOnce();
	});

	it('ignores registration errors during offline startup', async () => {
		const register = vi.fn(async () => {
			throw new TypeError('Offline');
		});

		await expect(registerServiceWorker({ register })).resolves.toBeUndefined();
	});
});
