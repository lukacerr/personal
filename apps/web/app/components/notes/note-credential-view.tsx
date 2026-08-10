import {
	CredentialValueActions,
	CredentialValueBody,
} from '@web/components/credentials/credential-value';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import type { CredentialValueState } from '@web/lib/credentials';
import type { CredentialBlockState } from '@web/lib/notes-credentials';
import { KeyRoundIcon, LockIcon } from 'lucide-react';

/**
 * A credential inside a note.
 *
 * Pure on purpose — no editor, no store, no network — so every state it can be in
 * is reachable from a test. It reuses the Credentials screen's value cell rather
 * than drawing its own mask, so the two cannot disagree about what a locked or
 * unreadable value looks like.
 *
 * `w-full` because BlockNote draws the selection outline on the child of
 * `.bn-block-content` rather than on the container.
 */

/** The one-line shapes: nothing to reveal, so nothing needs a second row. */
const notice =
	'flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-3 py-2.5';

export function NoteCredentialView({
	state,
	title,
	value,
	shown,
	editable,
	onChoose,
	onToggleShown,
	onCopy,
	onUnlock,
	onRetry,
}: {
	state: CredentialBlockState;
	/** Denormalised into the block, so it survives the credential being deleted. */
	title: string;
	/** The plaintext, only ever present while `state` is `ready`. */
	value?: string;
	shown: boolean;
	editable: boolean;
	onChoose: () => void;
	onToggleShown: () => void;
	onCopy: () => void;
	onUnlock: () => void;
	onRetry: () => void;
}) {
	if (state === 'empty')
		return (
			<div className={notice}>
				<KeyRoundIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				{editable ? (
					<Button variant="outline" size="sm" onClick={onChoose}>
						Choose a credential
					</Button>
				) : (
					<span className="text-muted-foreground text-sm">
						No credential was chosen.
					</span>
				)}
			</div>
		);

	if (state === 'loading')
		return (
			<div className={notice}>
				<Spinner className="size-4 shrink-0" />
				<span className="text-muted-foreground text-sm">
					Loading credential…
				</span>
			</div>
		);

	/**
	 * The public page never resolves a credential at all, so it has nothing to say
	 * about this one — not even its title. The file block can lean on a public
	 * endpoint that 404s identically for private and missing files; there is no
	 * public credential endpoint, and there must not be one, so the refusal is the
	 * client's and it is unconditional.
	 */
	if (state === 'unavailable')
		return (
			<div className={notice}>
				<LockIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="text-muted-foreground text-sm">
					This note references a credential, which is not shared.
				</span>
			</div>
		);

	if (state === 'missing')
		return (
			<div className={notice}>
				<KeyRoundIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="min-w-0 text-muted-foreground text-sm">
					“{title}” is no longer in Credentials.
				</span>
			</div>
		);

	if (state === 'failed')
		return (
			<div className={notice}>
				<KeyRoundIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="min-w-0 text-muted-foreground text-sm">
					“{title}” could not be loaded.
				</span>
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			</div>
		);

	const cellValue: CredentialValueState =
		state === 'ready'
			? { state: 'readable', value: value ?? '' }
			: state === 'unreadable'
				? { state: 'unreadable' }
				: { state: 'locked' };

	// Header and value on separate rows. Beside each other, a page of recovery
	// codes pushed the title and the buttons into the middle of the block and left
	// a column of empty space next to them.
	return (
		<div className="grid w-full gap-2 rounded-xl border bg-card px-3 py-2.5">
			<div className="flex items-center gap-2">
				<KeyRoundIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">
					{title}
				</span>
				<CredentialValueActions
					title={title}
					value={cellValue}
					shown={shown}
					onToggleShown={onToggleShown}
					onCopy={onCopy}
				/>
			</div>
			<CredentialValueBody
				title={title}
				value={cellValue}
				shown={shown}
				onUnlock={onUnlock}
			/>
		</div>
	);
}
