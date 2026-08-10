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
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Spinner } from '@web/components/ui/spinner';
import { verifyCredentialsSecret } from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * Asks for the secret, and refuses one that does not fit.
 *
 * The check is a trial decryption of a credential already on screen, which is a
 * single AES-GCM operation and needs no extra field in the envelope to compare
 * against. Getting it wrong is reported inline and never as a toast: the wrong
 * secret is still the wrong secret after a notification fades.
 */
export function CredentialUnlockDialog({
	open,
	samples,
	onUnlock,
	onClose,
}: {
	open: boolean;
	/** What to verify against. Empty means there is nothing to be wrong about yet. */
	samples: Array<Pick<Credential, 'value'>>;
	onUnlock: (secret: string) => void;
	onClose: () => void;
}) {
	const [secret, setSecret] = useState('');
	const [shown, setShown] = useState(false);
	const [error, setError] = useState<string>();
	const [checking, setChecking] = useState(false);

	function reset() {
		setSecret('');
		setShown(false);
		setError(undefined);
		setChecking(false);
	}

	async function submit() {
		if (!secret) {
			setError('Enter the secret to continue.');
			return;
		}

		setChecking(true);
		const fits = await verifyCredentialsSecret(secret, samples);
		setChecking(false);

		if (!fits) {
			setError(
				'That is not the secret these credentials were encrypted with. Nothing was saved.',
			);
			return;
		}

		onUnlock(secret);
		reset();
		onClose();
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) return;
				reset();
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Unlock credentials</DialogTitle>
						<DialogDescription>
							Values are decrypted on this device. The secret is kept here and
							never sent to the server.
						</DialogDescription>
					</DialogHeader>

					<InputGroup>
						<InputGroupInput
							autoFocus
							type={shown ? 'text' : 'password'}
							value={secret}
							autoComplete="off"
							placeholder="Encryption secret"
							aria-label="Encryption secret"
							aria-invalid={error !== undefined}
							onChange={(event) => {
								setSecret(event.target.value);
								setError(undefined);
							}}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								type="button"
								aria-label={shown ? 'Hide secret' : 'Show secret'}
								onClick={() => setShown((value) => !value)}
							>
								{shown ? <EyeOffIcon /> : <EyeIcon />}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>

					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}

					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={checking}>
							{checking ? <Spinner data-icon="inline-start" /> : null} Unlock
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
