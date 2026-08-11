// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialList } from '@web/components/credentials/credential-list';
import {
	CREDENTIAL_MASK,
	type CredentialValueState,
} from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function credential(overrides: Partial<Credential> = {}) {
	return {
		id: 'credential-1',
		title: 'Amex',
		value: 'v1.salt.iv.ciphertext',
		createdAt: Date.UTC(2026, 0, 15),
		updatedAt: Date.UTC(2026, 0, 15),
		...overrides,
	} as Credential;
}

function renderList(
	overrides: Partial<Parameters<typeof CredentialList>[0]> = {},
) {
	const props = {
		credentials: [credential()],
		values: new Map<string, CredentialValueState>([
			['credential-1', { state: 'readable', value: '4111 1111 1111 1111' }],
		]),
		shown: new Set<string>(),
		selectedId: null,
		onToggleShown: vi.fn(),
		onCopy: vi.fn(),
		onEdit: vi.fn(),
		onDelete: vi.fn(),
		onUnlock: vi.fn(),
		...overrides,
	};
	render(<CredentialList {...props} />);
	return props;
}

describe('Credential list', () => {
	/**
	 * The whole point of the screen: a value is never on screen until somebody
	 * asks for it, so a shoulder or a screenshot gets the mask.
	 */
	it('masks a readable value until it is revealed', () => {
		renderList();
		expect(screen.getByText(CREDENTIAL_MASK)).toBeTruthy();
		expect(screen.queryByText('4111 1111 1111 1111')).toBeNull();
	});

	it('shows the value once that row is revealed', () => {
		renderList({ shown: new Set(['credential-1']) });
		expect(screen.getByText('4111 1111 1111 1111')).toBeTruthy();
		expect(screen.queryByText(CREDENTIAL_MASK)).toBeNull();
	});

	it('reveals only the row whose eye was used', async () => {
		const props = renderList({
			credentials: [
				credential(),
				credential({ id: 'credential-2', title: 'Gmail' }),
			],
			values: new Map<string, CredentialValueState>([
				['credential-1', { state: 'readable', value: 'card' }],
				['credential-2', { state: 'readable', value: 'token' }],
			]),
		});

		await userEvent.click(screen.getByRole('button', { name: 'Show Gmail' }));
		expect(props.onToggleShown).toHaveBeenCalledTimes(1);
		expect(props.onToggleShown).toHaveBeenCalledWith('credential-2');
	});

	it('offers to unlock instead of a mask when there is no secret', async () => {
		const props = renderList({
			values: new Map<string, CredentialValueState>([
				['credential-1', { state: 'locked' }],
			]),
		});

		expect(screen.queryByText(CREDENTIAL_MASK)).toBeNull();
		await userEvent.click(
			screen.getByRole('button', { name: 'Unlock to view Amex' }),
		);
		expect(props.onUnlock).toHaveBeenCalledTimes(1);
	});

	/**
	 * A row the current secret cannot open says so rather than showing an empty
	 * mask, which would read as a credential with no value.
	 */
	it('says a value cannot be read rather than showing an empty mask', () => {
		renderList({
			values: new Map<string, CredentialValueState>([
				['credential-1', { state: 'unreadable' }],
			]),
		});

		expect(
			screen.getByText(
				'This value cannot be read with the secret saved on this device.',
			),
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Copy Amex' })).toBeNull();
		expect(screen.queryByText(CREDENTIAL_MASK)).toBeNull();
	});

	/**
	 * A value with no entry yet is locked, not readable: the decryption pass runs
	 * after the list renders, and defaulting the other way would flash a mask over
	 * something that turns out to be unreadable.
	 */
	it('treats a value it has not resolved yet as locked', () => {
		renderList({ values: new Map() });
		expect(
			screen.getByRole('button', { name: 'Unlock to view Amex' }),
		).toBeTruthy();
	});

	/**
	 * A card number and a page of recovery codes have to occupy the same space. A
	 * box that grew to fit meant revealing one value pushed the rest of the vault
	 * down and reflowed the whole grid row it sat in.
	 */
	it('keeps a multi-line value on one line', () => {
		const codes = Array.from({ length: 16 }, (_, index) => `code-${index + 1}`);
		renderList({
			values: new Map<string, CredentialValueState>([
				['credential-1', { state: 'readable', value: codes.join('\n') }],
			]),
			shown: new Set(['credential-1']),
		});

		const rendered = screen.getByRole('listitem').textContent ?? '';
		expect(rendered).not.toContain('\n');
		expect(rendered).toContain('code-1 code-2');
	});

	it('shows the whole value in a dialog, newlines and all', async () => {
		const value = 'first-line\nsecond-line\nthird-line';
		const props = renderList({
			values: new Map<string, CredentialValueState>([
				['credential-1', { state: 'readable', value }],
			]),
			shown: new Set(['credential-1']),
		});

		await userEvent.click(
			screen.getByRole('button', { name: 'Show Amex in full' }),
		);

		const dialog = await screen.findByRole('dialog');
		expect(dialog.textContent).toContain('third-line');
		// The dialog is where a long value is read, so copying belongs in it too.
		await userEvent.click(
			within(dialog).getByRole('button', { name: /^Copy$/ }),
		);
		expect(props.onCopy).toHaveBeenCalledTimes(1);
	});

	/**
	 * The expander is offered whether or not the value is revealed. A control that
	 * appeared only once something was revealed would change the card's height on
	 * every toggle, which is the growth this layout exists to avoid.
	 */
	it('offers the full value whether or not the row is revealed', () => {
		const values = new Map<string, CredentialValueState>([
			['credential-1', { state: 'readable', value: 'a\nb\nc' }],
		]);

		renderList({ values, shown: new Set() });
		expect(
			screen.getByRole('button', { name: 'Show Amex in full' }),
		).toBeTruthy();

		cleanup();
		renderList({ values, shown: new Set(['credential-1']) });
		expect(
			screen.getByRole('button', { name: 'Show Amex in full' }),
		).toBeTruthy();
	});

	it('names every action after the credential it acts on', async () => {
		const props = renderList();

		await userEvent.click(screen.getByRole('button', { name: 'Copy Amex' }));
		await userEvent.click(screen.getByRole('button', { name: 'Edit Amex' }));
		await userEvent.click(screen.getByRole('button', { name: 'Delete Amex' }));

		expect(props.onCopy).toHaveBeenCalledTimes(1);
		expect(props.onEdit).toHaveBeenCalledTimes(1);
		expect(props.onDelete).toHaveBeenCalledTimes(1);
	});

	/**
	 * The action cluster must fit inside a narrow card. It has five fixed-size
	 * controls, so shrinking the title alone cannot prevent horizontal overflow.
	 */
	it('wraps a credential action cluster within a narrow card', () => {
		renderList();

		const actions = screen.getByRole('button', {
			name: 'Show Amex',
		}).parentElement;
		expect(actions?.className).toContain('flex-wrap');
		expect(actions?.className).toContain('max-w-full');
	});

	it('marks the credential a link pointed at as current', () => {
		renderList({ selectedId: 'credential-1' });
		expect(screen.getByRole('listitem').getAttribute('aria-current')).toBe(
			'true',
		);
	});

	it('explains an empty vault instead of rendering a blank panel', () => {
		renderList({ credentials: [] });
		expect(screen.getByText('No credentials yet')).toBeTruthy();
	});
});
