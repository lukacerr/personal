import {
	CredentialValueActions,
	CredentialValueBody,
} from '@web/components/credentials/credential-value';
import { Button } from '@web/components/ui/button';
import type { CredentialValueState } from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { KeyRoundIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef } from 'react';

const dateFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

function changedLabel(timestamp: number) {
	const date = new Date(timestamp);
	return date.toDateString() === new Date().toDateString()
		? `Today, ${timeFormat.format(date)}`
		: dateFormat.format(date);
}

/**
 * The credential list.
 *
 * A responsive grid rather than full-width rows: a credential is a title and a
 * short block, so one per row left most of a desktop empty and pushed the rest of
 * the vault below the fold. `items-start` keeps a card with an expanded value from
 * stretching the ones beside it.
 *
 * No virtualisation: a vault holds tens of entries, not thousands, so the
 * measuring machinery would cost more than it saves — and it sidesteps the two
 * traps this shell sets, where a virtualiser pointed at an inner container never
 * sees the document scroll and floating chrome positioned against the section ends
 * up far below the fold.
 */
export function CredentialList({
	credentials,
	values,
	shown,
	selectedId,
	onToggleShown,
	onCopy,
	onEdit,
	onDelete,
	onUnlock,
}: {
	credentials: Credential[];
	values: Map<string, CredentialValueState>;
	shown: Set<string>;
	/** Brought into view when the palette or a link pointed at one. */
	selectedId: string | null;
	onToggleShown: (id: string) => void;
	onCopy: (credential: Credential) => void;
	onEdit: (credential: Credential) => void;
	onDelete: (credential: Credential) => void;
	onUnlock: () => void;
}) {
	const selectedRef = useRef<HTMLLIElement | null>(null);

	useEffect(() => {
		if (!selectedId) return;
		selectedRef.current?.scrollIntoView({ block: 'center' });
	}, [selectedId]);

	if (credentials.length === 0)
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
				<KeyRoundIcon
					className="size-8 text-muted-foreground"
					aria-hidden="true"
				/>
				<p className="font-medium">No credentials yet</p>
				<p className="max-w-sm text-muted-foreground text-sm">
					Cards, tokens and anything else worth keeping encrypted. Values are
					sealed on this device before they are sent.
				</p>
			</div>
		);

	return (
		<ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
			{credentials.map((credential) => {
				const value = values.get(credential.id) ?? { state: 'locked' as const };
				const selected = credential.id === selectedId;
				return (
					<li
						key={credential.id}
						ref={selected ? selectedRef : undefined}
						aria-current={selected ? 'true' : undefined}
						// Cards stretch to their grid band and anchor their contents to the
						// top. Left to their natural height they ended at different points
						// and the list read as broken rows rather than as a grid; the slack
						// belongs below the value, not spread between the rows.
						className={`grid content-start gap-3 rounded-xl border bg-card p-4 transition-colors ${
							selected ? 'border-primary' : 'border-border'
						}`}
					>
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<h3 className="truncate font-medium">{credential.title}</h3>
								<p className="text-muted-foreground text-xs">
									Updated{' '}
									<time dateTime={new Date(credential.updatedAt).toISOString()}>
										{changedLabel(credential.updatedAt)}
									</time>
								</p>
							</div>

							<div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-0.5">
								<CredentialValueActions
									title={credential.title}
									value={value}
									shown={shown.has(credential.id)}
									copyShortcut={selected}
									onToggleShown={() => onToggleShown(credential.id)}
									onCopy={() => onCopy(credential)}
								/>
								{/* Separates acting on the value from acting on the record. */}
								<span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => onEdit(credential)}
									aria-label={`Edit ${credential.title}`}
								>
									<PencilIcon />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => onDelete(credential)}
									aria-label={`Delete ${credential.title}`}
								>
									<Trash2Icon />
								</Button>
							</div>
						</div>

						{/* Below the header, never beside it: a value can be a page of
						    recovery codes, and as a flex sibling it dragged the title and
						    the buttons into the middle of the block. */}
						<CredentialValueBody
							title={credential.title}
							value={value}
							shown={shown.has(credential.id)}
							onUnlock={onUnlock}
						/>
					</li>
				);
			})}
		</ul>
	);
}
