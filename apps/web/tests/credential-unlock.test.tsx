// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialUnlockDialog } from '@web/components/credentials/credential-unlock';
import type { Credential } from '@web/lib/credentials-api';
import { encryptCredentialValue } from '@web/lib/credentials-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const SECRET = 'the-real-secret-0123456789abcdef';

async function sample(secret = SECRET) {
	return {
		value: await encryptCredentialValue('hunter2', secret),
	} as Pick<Credential, 'value'>;
}

function renderDialog(
	overrides: Partial<Parameters<typeof CredentialUnlockDialog>[0]> = {},
) {
	const props = {
		open: true,
		samples: [],
		onUnlock: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	render(<CredentialUnlockDialog {...props} />);
	return props;
}

describe('the unlock dialog', () => {
	it('accepts the secret the credentials were sealed with', async () => {
		const props = renderDialog({ samples: [await sample()] });

		await userEvent.type(
			// A masked field has no `textbox` role, so it is found by its label.
			screen.getByLabelText('Encryption secret'),
			SECRET,
		);
		await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(props.onUnlock).toHaveBeenCalledWith(SECRET);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	/**
	 * Rejecting here rather than letting every row fail on its own is the whole
	 * reason the dialog verifies: a typo would otherwise look like a vault full of
	 * broken credentials. The message stays inline because a wrong secret is still
	 * wrong after a toast fades.
	 */
	it('refuses a secret that opens nothing and saves nothing', async () => {
		const props = renderDialog({ samples: [await sample()] });

		await userEvent.type(
			// A masked field has no `textbox` role, so it is found by its label.
			screen.getByLabelText('Encryption secret'),
			'not-the-secret',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(props.onUnlock).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	/**
	 * With nothing stored there is nothing to be wrong about, and the first write
	 * is validated by the API — which is the right place for that failure.
	 */
	it('accepts any secret when there is no credential to check against', async () => {
		const props = renderDialog({ samples: [] });

		await userEvent.type(
			// A masked field has no `textbox` role, so it is found by its label.
			screen.getByLabelText('Encryption secret'),
			'anything',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(props.onUnlock).toHaveBeenCalledWith('anything');
	});

	it('asks for something rather than submitting an empty secret', async () => {
		const props = renderDialog({ samples: [await sample()] });

		await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(props.onUnlock).not.toHaveBeenCalled();
	});

	it('keeps the secret masked until asked to show it', async () => {
		renderDialog();
		expect(
			screen.queryByRole('textbox', { name: 'Encryption secret' }),
		).toBeNull();

		await userEvent.click(screen.getByRole('button', { name: 'Show secret' }));
		expect(
			screen.getByRole('textbox', { name: 'Encryption secret' }),
		).toBeTruthy();
	});
});
