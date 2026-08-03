import { Layout, links } from '@web/root';
import { LoginPanel } from '@web/routes/login';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

describe('Login', () => {
	it('uses the LC favicon', () => {
		expect(links()).toContainEqual({
			rel: 'icon',
			type: 'image/svg+xml',
			href: '/favicon.svg',
		});
	});

	it('uses the dark theme by default', () => {
		const document = Layout({ children: null });

		expect(isValidElement<{ className?: string }>(document)).toBe(true);
		if (!isValidElement<{ className?: string }>(document)) return;
		expect(document.props.className).toBe('dark');
	});

	it('shows only the centered Google sign-in action', () => {
		const html = renderToStaticMarkup(
			<LoginPanel hasOAuthError={false} onSignIn={vi.fn()} />,
		);

		expect(html).toContain('Continue with Google');
		expect(html).not.toContain('Personal systems');
		expect(html).not.toContain('Welcome back');
		expect(html).not.toContain('Calendar');
	});
});
