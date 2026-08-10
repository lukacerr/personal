// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteCredentialView } from '@web/components/notes/note-credential-view';
import { CREDENTIAL_MASK } from '@web/lib/credentials';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function renderView(
	overrides: Partial<Parameters<typeof NoteCredentialView>[0]> = {},
) {
	const props = {
		state: 'ready' as const,
		title: 'Amex',
		value: '4111 1111 1111 1111',
		shown: false,
		editable: true,
		onChoose: vi.fn(),
		onToggleShown: vi.fn(),
		onCopy: vi.fn(),
		onUnlock: vi.fn(),
		onRetry: vi.fn(),
		...overrides,
	};
	render(<NoteCredentialView {...props} />);
	return props;
}

describe('the credential block view', () => {
	it('masks a resolved value until it is revealed', () => {
		renderView();
		expect(screen.getByText('Amex')).toBeTruthy();
		expect(screen.getByText(CREDENTIAL_MASK)).toBeTruthy();
		expect(screen.queryByText('4111 1111 1111 1111')).toBeNull();
	});

	it('shows the value once revealed and can copy it', async () => {
		const props = renderView({ shown: true });
		expect(screen.getByText('4111 1111 1111 1111')).toBeTruthy();

		await userEvent.click(screen.getByRole('button', { name: 'Copy Amex' }));
		expect(props.onCopy).toHaveBeenCalledTimes(1);
	});

	it('offers to unlock when there is no secret', async () => {
		const props = renderView({ state: 'locked', value: undefined });

		await userEvent.click(
			screen.getByRole('button', { name: 'Unlock to view Amex' }),
		);
		expect(props.onUnlock).toHaveBeenCalledTimes(1);
	});

	it('says a value cannot be read with the current secret', () => {
		renderView({ state: 'unreadable', value: undefined });
		expect(
			screen.getByText(
				'This value cannot be read with the secret saved on this device.',
			),
		).toBeTruthy();
	});

	/**
	 * Deleting a credential never touches the notes that pointed at it, so the
	 * block is the only thing that can say the reference went stale — and it can
	 * still name what it held, because the title lives in the block.
	 */
	it('names the credential that is gone', () => {
		renderView({ state: 'missing', value: undefined });
		expect(
			screen.getByText('“Amex” is no longer in Credentials.'),
		).toBeTruthy();
	});

	it('offers a retry when the index could not be loaded', async () => {
		const props = renderView({ state: 'failed', value: undefined });

		await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(props.onRetry).toHaveBeenCalledTimes(1);
	});

	/**
	 * The one state that must leak nothing. A public reader has no session and
	 * there is no public credential endpoint to fall back on, so the block shows
	 * neither the value nor the title it carries in its props.
	 */
	it('reveals neither the value nor the title on a public note', () => {
		renderView({ state: 'unavailable', shown: true, editable: false });

		expect(
			screen.getByText(
				'This note references a credential, which is not shared.',
			),
		).toBeTruthy();
		expect(screen.queryByText('Amex')).toBeNull();
		expect(screen.queryByText('4111 1111 1111 1111')).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('asks for a credential when the block is empty in the editor', async () => {
		const props = renderView({ state: 'empty', value: undefined });

		await userEvent.click(
			screen.getByRole('button', { name: 'Choose a credential' }),
		);
		expect(props.onChoose).toHaveBeenCalledTimes(1);
	});

	/** A read-only mount has nothing to choose with, so it says so instead. */
	it('does not offer a picker where nothing is editable', () => {
		renderView({ state: 'empty', value: undefined, editable: false });
		expect(
			screen.queryByRole('button', { name: 'Choose a credential' }),
		).toBeNull();
		expect(screen.getByText('No credential was chosen.')).toBeTruthy();
	});
});
