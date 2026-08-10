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
	CREDENTIAL_MASK,
	type CredentialValueState,
} from '@web/lib/credentials';
import {
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	LockIcon,
	Maximize2Icon,
} from 'lucide-react';
import { useState } from 'react';

/**
 * A credential's value, as everything that shows one draws it.
 *
 * Every card is the same height, whatever it holds. A value can be a card number,
 * a page of recovery codes or a private key, and letting the box grow to fit meant
 * revealing one pushed the whole grid down and reflowed the row it sat in. So the
 * box is always a single truncated line and the full text lives in a dialog, which
 * is the one place a scroll region belongs — in this shell the page itself scrolls.
 *
 * The expander is an action rather than a row under the box for the same reason: a
 * control that appears only once a value is revealed changes the card's height on
 * every toggle.
 *
 * Split into the actions and the body because they belong in different places in
 * the parent's layout. Shared by the Credentials list and the credential block
 * inside a note so the two cannot disagree about what a locked or unreadable value
 * looks like, and free of stores and network so every state is testable.
 */

/** The box in every state, so nothing about the value changes its height. */
const valueBox =
	'min-w-0 truncate rounded-lg bg-muted/40 px-3 py-2 font-mono text-sm';

/** Newlines collapse to spaces: the preview is one line by construction. */
function onOneLine(value: string) {
	return value.replace(/\s*\n\s*/g, ' ').trim();
}

export function CredentialValueActions({
	title,
	value,
	shown,
	onToggleShown,
	onCopy,
}: {
	/** Names the controls and titles the dialog. */
	title: string;
	value: CredentialValueState;
	shown: boolean;
	onToggleShown: () => void;
	onCopy: () => void;
}) {
	const [viewing, setViewing] = useState(false);

	// Nothing to reveal, copy or open until the value can actually be read.
	if (value.state !== 'readable') return null;

	return (
		<>
			<Button
				variant="ghost"
				size="icon-sm"
				onClick={onToggleShown}
				aria-label={shown ? `Hide ${title}` : `Show ${title}`}
			>
				{shown ? <EyeOffIcon /> : <EyeIcon />}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onClick={onCopy}
				aria-label={`Copy ${title}`}
			>
				<CopyIcon />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onClick={() => setViewing(true)}
				aria-label={`Show ${title} in full`}
			>
				<Maximize2Icon />
			</Button>

			<Dialog open={viewing} onOpenChange={setViewing}>
				{/* Wider than a default dialog: a private key at the standard width wraps
				    every line twice and stops looking like the thing it is. */}
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle className="truncate">{title}</DialogTitle>
						<DialogDescription>
							Decrypted on this device. Closing this leaves nothing behind.
						</DialogDescription>
					</DialogHeader>
					{/* A bounded scroller is right here and wrong in the list: a dialog is
					    an overlay of its own, where the page is not the thing scrolling. */}
					<div className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-sm">
						{value.value}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={onCopy}>
							<CopyIcon data-icon="inline-start" /> Copy
						</Button>
						<DialogClose render={<Button />}>Done</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function CredentialValueBody({
	title,
	value,
	shown,
	onUnlock,
}: {
	title: string;
	value: CredentialValueState;
	shown: boolean;
	onUnlock: () => void;
}) {
	if (value.state === 'locked')
		return (
			<Button
				variant="outline"
				size="sm"
				onClick={onUnlock}
				aria-label={`Unlock to view ${title}`}
			>
				<LockIcon data-icon="inline-start" /> Unlock to view
			</Button>
		);

	if (value.state === 'unreadable')
		return (
			<p className="text-muted-foreground text-sm">
				This value cannot be read with the secret saved on this device.
			</p>
		);

	if (!shown)
		return (
			<div
				className={`${valueBox} select-none text-muted-foreground tracking-widest`}
			>
				{CREDENTIAL_MASK}
			</div>
		);

	return <div className={valueBox}>{onOneLine(value.value)}</div>;
}
