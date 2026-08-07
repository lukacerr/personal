import { LoginPanel } from '@web/routes/login';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

describe('Login', () => {
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
