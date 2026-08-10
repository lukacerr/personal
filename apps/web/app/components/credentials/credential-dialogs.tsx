import { Button } from '@web/components/ui/button';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import { Textarea } from '@web/components/ui/textarea';
import type { Credential } from '@web/lib/credentials-api';
import { LockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

export type CredentialFormTarget =
	| { kind: 'create' }
	| { kind: 'edit'; credential: Credential };

/**
 * Creating and editing a credential.
 *
 * One dialog for both because the difference is a single field's behaviour: on an
 * edit, leaving the value blank keeps the ciphertext exactly as it is. That is
 * also what lets a locked vault rename something it cannot read — the value box
 * is the only part that needs the secret.
 */
export function CredentialFormDialog({
	target,
	locked,
	busy,
	error,
	onSubmit,
	onUnlock,
	onClose,
}: {
	target: CredentialFormTarget | undefined;
	locked: boolean;
	busy: boolean;
	/** Stays inside the dialog: a rejected save is a condition, not a notice. */
	error: string | undefined;
	onSubmit: (values: { title: string; plaintext?: string }) => void;
	onUnlock: () => void;
	onClose: () => void;
}) {
	const editing = target?.kind === 'edit' ? target.credential : undefined;
	const [title, setTitle] = useState('');
	const [plaintext, setPlaintext] = useState('');
	const [invalid, setInvalid] = useState<string>();

	// Keyed on the target's identity rather than on its contents: the parent builds
	// a fresh one every time the dialog opens, so reopening the *same* credential
	// still clears whatever was typed into it last time. Keying on the id or the
	// title would leave that stale.
	useEffect(() => {
		setTitle(target?.kind === 'edit' ? target.credential.title : '');
		setPlaintext('');
		setInvalid(undefined);
	}, [target]);

	function submit() {
		const trimmed = title.trim();
		if (!trimmed) {
			setInvalid('A credential needs a title.');
			return;
		}
		// The same rule the API enforces, checked here so a long paste is caught
		// before it becomes a round trip.
		if (plaintext.length > 4096) {
			setInvalid('This value is too long. The limit is 4096 characters.');
			return;
		}
		if (!editing && !plaintext) {
			setInvalid('A credential needs a value.');
			return;
		}

		onSubmit({
			title: trimmed,
			...(plaintext === '' ? {} : { plaintext }),
		});
	}

	// What the form typed itself wins over what the server said about the last
	// attempt: the newer complaint is the one the user can act on.
	const message = invalid ?? error;

	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{editing ? 'Edit credential' : 'New credential'}
						</DialogTitle>
						<DialogDescription>
							{editing
								? 'The value is encrypted on this device before it is sent. Leave it blank to keep the current one.'
								: 'The value is encrypted on this device before it is sent. The server never sees it.'}
						</DialogDescription>
					</DialogHeader>

					<Input
						value={title}
						placeholder="Title"
						aria-label="Credential title"
						onChange={(event) => {
							setTitle(event.target.value);
							setInvalid(undefined);
						}}
					/>

					{locked ? (
						<div className="grid gap-2 rounded-lg border border-dashed p-3">
							<p className="text-muted-foreground text-sm">
								{editing
									? 'The vault is locked, so the value cannot be changed. The title can.'
									: 'The vault is locked, so there is no key to encrypt a value with.'}
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="justify-self-start"
								onClick={onUnlock}
							>
								<LockIcon data-icon="inline-start" /> Unlock
							</Button>
						</div>
					) : (
						<Textarea
							value={plaintext}
							rows={4}
							placeholder={
								editing ? 'New value (leave blank to keep)' : 'Value'
							}
							aria-label="Credential value"
							className="font-mono"
							onChange={(event) => {
								setPlaintext(event.target.value);
								setInvalid(undefined);
							}}
						/>
					)}

					{message ? (
						<p role="alert" className="text-destructive text-sm">
							{message}
						</p>
					) : null}

					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{busy ? <Spinner data-icon="inline-start" /> : null}{' '}
							{editing ? 'Save' : 'Create'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function CredentialDeleteDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target: Credential | undefined;
	busy: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete credential</DialogTitle>
					<DialogDescription>
						“{target?.title}” will be permanently deleted. If nothing else holds
						this value, it cannot be recovered.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button variant="destructive" onClick={onConfirm} disabled={busy}>
						{busy ? <Spinner data-icon="inline-start" /> : null} Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
