// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { api } from '@web/lib/api';
import { classifyApiHealth, useApiHealth } from '@web/lib/availability';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/api', () => ({
	api: { health: { get: vi.fn() } },
}));

afterEach(cleanup);

type HealthResult = Awaited<ReturnType<typeof api.health.get>>;

const healthy = {
	data: {
		status: 'operational',
		checkedAt: '2026-08-05T12:00:00.000Z',
		services: { dbCheck: true, cacheCheck: true, storageCheck: true },
	},
	error: null,
} as unknown as HealthResult;

const unreachable = {
	data: null,
	error: { status: 503, value: null },
} as unknown as HealthResult;

describe('Availability indicators', () => {
	it('classifies health and renders concise accessible availability', async () => {
		expect(
			classifyApiHealth({
				status: 'operational',
				checkedAt: '2026-08-05T12:00:00.000Z',
				services: {
					dbCheck: true,
					cacheCheck: true,
					storageCheck: true,
				},
			}),
		).toBe('healthy');
		expect(
			classifyApiHealth({
				status: 'partial',
				checkedAt: '2026-08-05T12:00:00.000Z',
				services: {
					dbCheck: true,
					cacheCheck: false,
					storageCheck: true,
				},
			}),
		).toBe('partial');
		expect(classifyApiHealth(undefined)).toBe('down');
		const { AppAvailabilityBadges } = await import(
			'@web/components/app-availability-badges'
		);
		const html = renderToStaticMarkup(
			<AppAvailabilityBadges
				apiHealth={{
					status: 'healthy',
					checkedAt: '2026-08-05T12:00:00.000Z',
					services: {
						dbCheck: true,
						cacheCheck: true,
						storageCheck: true,
					},
				}}
				pwaAvailability="offline"
			/>,
		);

		expect(html).toContain('aria-label="PWA offline"');
		expect(html).toContain('aria-label="API Healthy"');
		expect(html).toContain('>PWA<');
		expect(html).toContain('>Healthy<');
	});

	/**
	 * One check at mount goes stale the moment the laptop sleeps or the tab is
	 * backgrounded. Coming back online or to the foreground re-asks — the two
	 * moments the answer can have changed — with no continuous polling.
	 */
	it('re-checks API health on returning online or visible', async () => {
		const healthGet = vi.mocked(api.health.get);
		healthGet.mockResolvedValue(healthy);

		const { result } = renderHook(() => useApiHealth());
		await waitFor(() => expect(result.current.status).toBe('healthy'));
		expect(healthGet).toHaveBeenCalledTimes(1);

		healthGet.mockResolvedValue(unreachable);
		window.dispatchEvent(new Event('online'));
		await waitFor(() => expect(result.current.status).toBe('down'));
		expect(healthGet).toHaveBeenCalledTimes(2);

		healthGet.mockResolvedValue(healthy);
		document.dispatchEvent(new Event('visibilitychange'));
		await waitFor(() => expect(result.current.status).toBe('healthy'));
		expect(healthGet).toHaveBeenCalledTimes(3);
	});
});
