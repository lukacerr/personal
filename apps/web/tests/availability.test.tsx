import { classifyApiHealth } from '@web/lib/availability';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
});
