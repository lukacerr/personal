import { Button } from '@web/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import type { AgentThread } from '@web/lib/agent-api';
import { useId, useState } from 'react';

/**
 * Both dialogs keep their failure inline: a toast would vanish while the
 * condition it reports — the rename that did not land, the delete that could
 * not reach the server — is still true in front of the user.
 */
export function ThreadRenameDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target?: AgentThread;
	busy: boolean;
	error?: string;
	onConfirm: (title: string) => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			{/* Keyed by thread so reopening on another row starts from its title. */}
			{target && (
				<RenameForm
					key={target.id}
					title={target.title}
					busy={busy}
					error={error}
					onConfirm={onConfirm}
					onClose={onClose}
				/>
			)}
		</Dialog>
	);
}

function RenameForm({
	title,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	title: string;
	busy: boolean;
	error?: string;
	onConfirm: (title: string) => void;
	onClose: () => void;
}) {
	const inputId = useId();
	const [value, setValue] = useState(title);

	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle>Rename conversation</DialogTitle>
				<DialogDescription>
					The title is how this conversation reads in the list and the palette.
				</DialogDescription>
			</DialogHeader>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (value.trim().length === 0) return;
					onConfirm(value.trim());
				}}
			>
				<div className="flex flex-col gap-2">
					<label htmlFor={inputId} className="font-medium text-sm">
						Title
					</label>
					<Input
						id={inputId}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						maxLength={255}
						autoFocus
					/>
				</div>
				{error && <p className="text-destructive text-sm">{error}</p>}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={busy || value.trim().length === 0}>
						{busy ? 'Renaming…' : 'Rename'}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

export function ThreadDeleteDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target?: AgentThread;
	busy: boolean;
	error?: string;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete conversation</DialogTitle>
					<DialogDescription>
						“{target?.title}” and every message in it will be gone. There is no
						undo.
					</DialogDescription>
				</DialogHeader>
				{error && <p className="text-destructive text-sm">{error}</p>}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={onConfirm}
						disabled={busy}
					>
						{busy ? 'Deleting…' : 'Delete'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ThreadBulkDeleteDialog({
	count,
	open,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	count: number;
	open: boolean;
	busy: boolean;
	error?: string;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete {count} conversations?</DialogTitle>
					<DialogDescription>
						Every message in the selected conversations will be gone. There is
						no undo.
					</DialogDescription>
				</DialogHeader>
				{error ? <p className="text-destructive text-sm">{error}</p> : null}
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} disabled={busy}>
						{busy ? 'Deleting…' : `Delete ${count}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
