// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialFormDialog } from '@web/components/credentials/credential-dialogs';
import type { Credential } from '@web/lib/credentials-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const existing = {
	id: 'credential-1',
	title: 'Amex',
	value: 'v1.salt.iv.ciphertext',
	createdAt: Date.UTC(2026, 0, 15),
	updatedAt: Date.UTC(2026, 0, 15),
} as Credential;

function renderForm(
	overrides: Partial<Parameters<typeof CredentialFormDialog>[0]> = {},
) {
	const props = {
		target: { kind: 'create' } as Parameters<
			typeof CredentialFormDialog
		>[0]['target'],
		locked: false,
		busy: false,
		error: undefined,
		onSubmit: vi.fn(),
		onUnlock: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	render(<CredentialFormDialog {...props} />);
	return props;
}

describe('the credential form', () => {
	it('creates with a title and a value', async () => {
		const props = renderForm();

		await userEvent.type(
			screen.getByRole('textbox', { name: 'Credential title' }),
			'Gmail',
		);
		await userEvent.type(
			screen.getByRole('textbox', { name: 'Credential value' }),
			'app-password',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(props.onSubmit).toHaveBeenCalledWith({
			title: 'Gmail',
			plaintext: 'app-password',
		});
	});

	/**
	 * Renaming needs no secret — the API leaves the ciphertext alone when no value
	 * is sent — so a locked vault still has to be able to submit. Omitting
	 * `plaintext` entirely rather than sending an empty string is what carries that
	 * distinction to the server.
	 */
	it('renames a credential it cannot read, without touching the value', async () => {
		const props = renderForm({
			target: { kind: 'edit', credential: existing },
			locked: true,
		});

		const title = screen.getByRole('textbox', { name: 'Credential title' });
		expect((title as HTMLInputElement).value).toBe('Amex');
		expect(
			screen.queryByRole('textbox', { name: 'Credential value' }),
		).toBeNull();

		await userEvent.clear(title);
		await userEvent.type(title, 'Amex Gold');
		await userEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(props.onSubmit).toHaveBeenCalledWith({ title: 'Amex Gold' });
	});

	it('offers to unlock instead of a value box while locked', async () => {
		const props = renderForm({ locked: true });

		await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
		expect(props.onUnlock).toHaveBeenCalledTimes(1);
	});

	it('keeps the current value when an edit leaves the box empty', async () => {
		const props = renderForm({
			target: { kind: 'edit', credential: existing },
		});

		await userEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSubmit).toHaveBeenCalledWith({ title: 'Amex' });
	});

	it('refuses to create a credential with no value', async () => {
		const props = renderForm();

		await userEvent.type(
			screen.getByRole('textbox', { name: 'Credential title' }),
			'Gmail',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	it('refuses a blank title', async () => {
		const props = renderForm();

		await userEvent.type(
			screen.getByRole('textbox', { name: 'Credential title' }),
			'   ',
		);
		await userEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	/**
	 * The same bound the API enforces after decrypting, checked here so a long
	 * paste is caught before it costs a round trip.
	 */
	it('refuses a value past the size limit before sending it', async () => {
		const props = renderForm();

		await userEvent.type(
			screen.getByRole('textbox', { name: 'Credential title' }),
			'Huge',
		);
		// Set directly rather than typed: `userEvent.paste` needs a clipboard event
		// happy-dom does not build, and 4097 keystrokes is not a test worth waiting for.
		fireEvent.change(
			screen.getByRole('textbox', { name: 'Credential value' }),
			{
				target: { value: 'x'.repeat(4097) },
			},
		);
		await userEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	it('shows what the server said about the last attempt', () => {
		renderForm({ error: 'A credential with this title already exists.' });
		expect(
			screen.getByText('A credential with this title already exists.'),
		).toBeTruthy();
	});
});
