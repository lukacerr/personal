import { readFile } from 'node:fs/promises';
import { isTransientApiFailure } from '@web/lib/api';
import { registerServiceWorker } from '@web/lib/register-service-worker';
import { describe, expect, it, vi } from 'vitest';

describe('Offline app shell', () => {
	it('serves the service worker without browser or CDN caching', async () => {
		const headers = await readFile('public/_headers', 'utf8');

		expect(headers).toContain(
			'/sw.js\n  Cache-Control: no-cache, no-store, must-revalidate',
		);
	});

	it('keeps authentication through transient API failures', () => {
		expect(isTransientApiFailure(503)).toBe(true);
		expect(isTransientApiFailure(401)).toBe(false);
	});

	it('registers the service worker and checks for updates', async () => {
		const update = vi.fn(async () => undefined);
		const register = vi.fn(async () => ({ update }));
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();

		await registerServiceWorker({
			controller: null,
			register,
			addEventListener,
			removeEventListener,
		});

		expect(register).toHaveBeenCalledWith('/sw.js', {
			updateViaCache: 'none',
		});
		expect(update).toHaveBeenCalledOnce();
	});

	it('reloads once when an updated worker takes control', async () => {
		let onControllerChange = () => {};
		const reload = vi.fn();

		await registerServiceWorker(
			{
				controller: {},
				register: vi.fn(async () => ({ update: vi.fn() })),
				addEventListener: vi.fn((_type, listener) => {
					onControllerChange = listener;
				}),
				removeEventListener: vi.fn(),
			},
			reload,
		);

		onControllerChange();
		onControllerChange();

		expect(reload).toHaveBeenCalledOnce();
	});

	it('does not reload when the first worker takes control', async () => {
		let onControllerChange = () => {};
		const reload = vi.fn();

		await registerServiceWorker(
			{
				controller: null,
				register: vi.fn(async () => ({ update: vi.fn() })),
				addEventListener: vi.fn((_type, listener) => {
					onControllerChange = listener;
				}),
				removeEventListener: vi.fn(),
			},
			reload,
		);

		onControllerChange();

		expect(reload).not.toHaveBeenCalled();
	});

	it('checks for updates when the app returns to the foreground', async () => {
		let onVisibilityChange = () => {};
		let visibilityState = 'hidden';
		const update = vi.fn(async () => undefined);

		await registerServiceWorker(
			{
				controller: {},
				register: vi.fn(async () => ({ update })),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			},
			vi.fn(),
			{
				get visibilityState() {
					return visibilityState;
				},
				addEventListener: vi.fn((_type, listener) => {
					onVisibilityChange = listener;
				}),
				removeEventListener: vi.fn(),
			},
		);

		onVisibilityChange();
		expect(update).toHaveBeenCalledOnce();

		visibilityState = 'visible';
		onVisibilityChange();
		expect(update).toHaveBeenCalledTimes(2);
	});

	it('ignores registration errors during offline startup', async () => {
		const register = vi.fn(async () => {
			throw new TypeError('Offline');
		});

		await expect(
			registerServiceWorker({
				controller: null,
				register,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			}),
		).resolves.toBeTypeOf('function');
	});
});
