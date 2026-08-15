import {
	CredentialDeleteDialog,
	CredentialFormDialog,
	type CredentialFormTarget,
} from '@web/components/credentials/credential-dialogs';
import { CredentialList } from '@web/components/credentials/credential-list';
import { CredentialToolbar } from '@web/components/credentials/credential-toolbar';
import { CredentialUnlockDialog } from '@web/components/credentials/credential-unlock';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import {
	filterCredentials,
	isAddCredentialShortcut,
	isCopyCredentialShortcut,
	isToggleRevealShortcut,
	parseCredentialsView,
	updateCredentialsSearchParams,
} from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { useCredentials } from '@web/lib/credentials-vault';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

export function meta() {
	return [{ title: 'Credentials · Personal' }];
}

export default function Credentials() {
	const [searchParams, setSearchParams] = useSearchParams();
	const view = parseCredentialsView(searchParams);
	const [queryInput, setQueryInput] = useState(view.query);

	const [shown, setShown] = useState<Set<string>>(new Set());
	const [form, setForm] = useState<CredentialFormTarget>();
	const [formError, setFormError] = useState<string>();
	const [deleting, setDeleting] = useState<Credential>();
	const [deleteError, setDeleteError] = useState<string>();
	const [dialogBusy, setDialogBusy] = useState(false);
	const [unlocking, setUnlocking] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const vault = useCredentials();
	const { credentials, values, secret, copy } = vault;
	const locked = secret === undefined;

	const visible = useMemo(
		() => filterCredentials(credentials, view.query),
		[credentials, view.query],
	);

	useEffect(() => {
		setQueryInput(view.query);
	}, [view.query]);

	// Debounced so typing does not write a history entry per keystroke, and
	// `replace` so the back button still leaves the screen rather than unwinding
	// the search letter by letter.
	useEffect(() => {
		if (queryInput === view.query) return;
		const timeout = window.setTimeout(() => {
			setSearchParams(
				(current) =>
					updateCredentialsSearchParams(current, { query: queryInput }),
				{ replace: true },
			);
		}, 150);
		return () => window.clearTimeout(timeout);
	}, [queryInput, setSearchParams, view.query]);

	// Locking again hides everything: a mask over a value nobody can decrypt any
	// more would claim there is something to show.
	useEffect(() => {
		if (locked) setShown(new Set());
	}, [locked]);

	/**
	 * Anything that needs a decrypted value goes through here. Asking for the
	 * secret at the moment it is first needed beats a gate on the whole screen:
	 * the list, the titles and renaming all work without it.
	 */
	const requireSecret = useCallback(() => {
		if (locked) setUnlocking(true);
		return !locked;
	}, [locked]);

	function toggleShown(id: string) {
		if (!requireSecret()) return;
		setShown((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}

	const toggleAllShown = useCallback(() => {
		setShown((current) =>
			current.size > 0 ? new Set() : new Set(visible.map(({ id }) => id)),
		);
	}, [visible]);

	/** The row the palette or a shared link pointed at, if it still exists. */
	const selected = view.selected
		? credentials.find((credential) => credential.id === view.selected)
		: undefined;

	/**
	 * The bare letters: R mirrors the toolbar's Reveal all / Hide all, C copies
	 * the selected credential. Any dialog already being open is a skip rather
	 * than something the predicates could know: focus inside one often rests on
	 * a button rather than a field, so the editable check alone would let the
	 * key act over a dialog halfway through. While locked, both keys ask for the
	 * secret instead — the same thing their buttons do.
	 */
	const dialogOpen = form !== undefined || deleting !== undefined || unlocking;

	useEffect(() => {
		if (dialogOpen) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (isAddCredentialShortcut(event)) {
				event.preventDefault();
				setFormError(undefined);
				setForm({ kind: 'create' });
				return;
			}
			if (isToggleRevealShortcut(event)) {
				event.preventDefault();
				if (requireSecret()) toggleAllShown();
				return;
			}
			if (selected && isCopyCredentialShortcut(event)) {
				event.preventDefault();
				if (requireSecret()) void copy(selected);
			}
		}

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [dialogOpen, requireSecret, toggleAllShown, selected, copy]);

	async function submitForm(values_: { title: string; plaintext?: string }) {
		if (!form) return;
		setDialogBusy(true);
		const failure =
			form.kind === 'edit'
				? await vault.update(form.credential, values_)
				: await vault.create(values_.title, values_.plaintext ?? '');
		setDialogBusy(false);

		if (failure) {
			setFormError(failure);
			return;
		}
		setForm(undefined);
	}

	async function confirmDelete() {
		if (!deleting) return;
		setDialogBusy(true);
		const failure = await vault.remove(deleting);
		setDialogBusy(false);

		if (failure) {
			setDeleteError(failure);
			return;
		}
		setShown((current) => {
			const next = new Set(current);
			next.delete(deleting.id);
			return next;
		});
		setDeleting(undefined);
	}

	return (
		<section
			aria-label="Credentials"
			className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6"
		>
			<CredentialToolbar
				query={queryInput}
				count={visible.length}
				locked={locked}
				anyShown={shown.size > 0}
				refreshing={refreshing}
				onQueryChange={setQueryInput}
				onToggleAllShown={toggleAllShown}
				onCreate={() => {
					setFormError(undefined);
					setForm({ kind: 'create' });
				}}
				onUnlock={() => setUnlocking(true)}
				onForget={vault.forget}
				onRefresh={async () => {
					setRefreshing(true);
					await vault.reload();
					setRefreshing(false);
				}}
			/>

			{vault.loading ? (
				<div className="flex flex-1 items-center justify-center gap-3 text-muted-foreground text-sm">
					<Spinner /> Loading credentials…
				</div>
			) : vault.loadError ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
					<p className="font-medium">{vault.loadError}</p>
					<Button variant="outline" onClick={() => void vault.reload()}>
						Try again
					</Button>
				</div>
			) : (
				<CredentialList
					credentials={visible}
					values={values}
					shown={shown}
					selectedId={view.selected}
					onToggleShown={toggleShown}
					onCopy={(credential) => {
						if (!requireSecret()) return;
						void vault.copy(credential);
					}}
					onEdit={(credential) => {
						setFormError(undefined);
						setForm({ kind: 'edit', credential });
					}}
					onDelete={(credential) => {
						setDeleteError(undefined);
						setDeleting(credential);
					}}
					onUnlock={() => setUnlocking(true)}
				/>
			)}

			<CredentialUnlockDialog
				open={unlocking}
				samples={credentials}
				onUnlock={vault.unlock}
				onClose={() => setUnlocking(false)}
			/>

			<CredentialFormDialog
				target={form}
				locked={locked}
				busy={dialogBusy}
				error={formError}
				onSubmit={(next) => void submitForm(next)}
				onUnlock={() => setUnlocking(true)}
				onClose={() => setForm(undefined)}
			/>

			<CredentialDeleteDialog
				target={deleting}
				busy={dialogBusy}
				error={deleteError}
				onConfirm={() => void confirmDelete()}
				onClose={() => setDeleting(undefined)}
			/>
		</section>
	);
}
