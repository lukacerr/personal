import { AppEnvironmentBadge } from '@web/components/app-environment-badge';
import { env } from '@web/lib/env';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('Application environment', () => {
	it('defaults to production when VITE_ENV is not configured', () => {
		expect(env.VITE_ENV).toBe('production');
	});

	it('shows the active environment in the application header', () => {
		const html = renderToStaticMarkup(
			<AppEnvironmentBadge environment="development" />,
		);

		expect(html).toContain('aria-label="Environment: development"');
		expect(html).toContain('>DEV<');
		expect(html).toContain('class="hidden sm:inline"');
	});
});
