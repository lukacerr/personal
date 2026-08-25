// @vitest-environment happy-dom
import {
	act,
	cleanup,
	render,
	renderHook,
	waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '@web/lib/api';
import { classifyApiHealth, useApiHealth } from '@web/lib/availability';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/api', () => ({
	api: { health: { get: vi.fn() } },
}));

afterEach(() => {
	cleanup();
	// Call counts are the assertion in most of these, so they start at zero.
	vi.clearAllMocks();
});

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
		// Names the status and the affordance: it is the only way to re-ask.
		expect(html).toContain('aria-label="API Healthy — check again"');
		expect(html).toContain('>PWA<');
		expect(html).toContain('>Healthy<');
	});

	/**
	 * The badge asks once, when the app opens, and then never on its own.
	 *
	 * It used to re-ask on `online` and on every `visibilitychange`, which is not
	 * a poll but behaves like one in ordinary use: every switch back to the tab
	 * cost a request, so a window someone alt-tabs past all afternoon kept the
	 * serverless container from ever going to sleep. Whether the API is up is a
	 * question with a person behind it, so now a person asks it.
	 */
	it('asks once at mount and then never by itself', async () => {
		const healthGet = vi.mocked(api.health.get);
		healthGet.mockResolvedValue(healthy);

		const { result } = renderHook(() => useApiHealth());
		await waitFor(() => expect(result.current.status).toBe('healthy'));
		expect(healthGet).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new Event('online'));
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		document.dispatchEvent(new Event('pointermove'));
		await Promise.resolve();

		expect(healthGet).toHaveBeenCalledTimes(1);
	});

	it('re-checks when asked, and reports what it found', async () => {
		const healthGet = vi.mocked(api.health.get);
		healthGet.mockResolvedValue(healthy);

		const { result } = renderHook(() => useApiHealth());
		await waitFor(() => expect(result.current.status).toBe('healthy'));

		healthGet.mockResolvedValue(unreachable);
		act(() => {
			result.current.recheck();
		});

		await waitFor(() => expect(result.current.status).toBe('down'));
		expect(healthGet).toHaveBeenCalledTimes(2);
	});

	/**
	 * The badge is the only way to re-ask now, so it has to be reachable as one:
	 * a real button, named for what it does, not a decorated span.
	 */
	it('offers the re-check as a button that says so', async () => {
		const onRecheck = vi.fn();
		const { AppAvailabilityBadges } = await import(
			'@web/components/app-availability-badges'
		);
		const { getByRole } = render(
			<AppAvailabilityBadges
				apiHealth={{ status: 'healthy' }}
				onRecheck={onRecheck}
				pwaAvailability="online"
			/>,
		);

		const button = getByRole('button', { name: /API Healthy/ });
		expect(button.getAttribute('aria-label')).toMatch(/check again/i);
		await userEvent.click(button);
		expect(onRecheck).toHaveBeenCalledTimes(1);
	});

	/** Connectivity changes on its own and costs nothing to read; it is not a button. */
	it('leaves the connectivity badge as a reading', async () => {
		const { AppAvailabilityBadges } = await import(
			'@web/components/app-availability-badges'
		);
		const { getAllByRole } = render(
			<AppAvailabilityBadges
				apiHealth={{ status: 'healthy' }}
				onRecheck={() => undefined}
				pwaAvailability="offline"
			/>,
		);

		expect(getAllByRole('button')).toHaveLength(1);
	});

	/** Mashing the badge must not open a request per click. */
	it('collapses repeated asks while one is still in flight', async () => {
		const healthGet = vi.mocked(api.health.get);
		healthGet.mockResolvedValue(healthy);
		const { result } = renderHook(() => useApiHealth());
		await waitFor(() => expect(result.current.status).toBe('healthy'));

		let release: (value: HealthResult) => void = () => undefined;
		healthGet.mockReturnValue(
			new Promise<HealthResult>((resolve) => {
				release = resolve;
			}) as ReturnType<typeof api.health.get>,
		);

		act(() => {
			result.current.recheck();
			result.current.recheck();
			result.current.recheck();
		});
		expect(healthGet).toHaveBeenCalledTimes(2);

		await act(async () => {
			release(healthy);
		});
		expect(healthGet).toHaveBeenCalledTimes(2);
	});
});
