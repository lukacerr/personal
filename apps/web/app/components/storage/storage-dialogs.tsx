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
import { Progress } from '@web/components/ui/progress';
import { Spinner } from '@web/components/ui/spinner';
import type { StoredFile } from '@web/lib/storage-api';

export type StorageDeleteTarget =
	| { kind: 'file'; file: StoredFile }
	| { kind: 'folder'; name: string }
	| { kind: 'bulk'; files: StoredFile[] };

function deleteTitle(target: StorageDeleteTarget | undefined) {
	if (target?.kind === 'folder') return 'Delete folder';
	if (target?.kind === 'bulk') return `Delete ${target.files.length} files`;
	return 'Delete file';
}

function deleteDescription(target: StorageDeleteTarget | undefined) {
	if (target?.kind === 'folder')
		return `“${target.name}” and every file inside it will be permanently deleted.`;
	if (target?.kind === 'bulk')
		return 'Every selected file will be permanently deleted. Files that fail remain selected so they can be retried.';
	return `“${target?.kind === 'file' ? target.file.name : ''}” will be permanently deleted.`;
}

export function StorageDeleteDialog({
	target,
	error,
	busy,
	onConfirm,
	onClose,
}: {
	target: StorageDeleteTarget | undefined;
	/** Stays inside the dialog: a partial failure is a condition, not a notice. */
	error: string | undefined;
	busy: boolean;
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
					<DialogTitle>{deleteTitle(target)}</DialogTitle>
					<DialogDescription>{deleteDescription(target)}</DialogDescription>
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

export function StorageBulkDownloadDialog({
	open,
	count,
	progress,
	error,
	onCancel,
}: {
	open: boolean;
	count: number;
	progress: number;
	error: string | undefined;
	onCancel: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Download ZIP</DialogTitle>
					<DialogDescription>
						Downloading and packaging {count} files.
					</DialogDescription>
				</DialogHeader>
				<Progress
					value={Math.round(progress * 100)}
					aria-label="Bulk download progress"
				/>
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function StorageReconcileDialog({
	open,
	busy,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reconcile storage</DialogTitle>
					<DialogDescription>
						This compares the bucket against the database and removes objects,
						rows or abandoned uploads that only exist on one side.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button onClick={onConfirm} disabled={busy}>
						{busy ? <Spinner data-icon="inline-start" /> : null} Reconcile
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
