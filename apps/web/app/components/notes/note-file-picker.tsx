import { Button } from '@web/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@web/components/ui/command';
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
import { uploadNoteFiles } from '@web/lib/notes-file-upload';
import { NOTES_UPLOAD_FOLDER } from '@web/lib/notes-files';
import { fileTypeIcon, fileTypeLabel, formatBytes } from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import type { UploadItem } from '@web/lib/storage-upload';
import { UploadIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * One dialog, two ways to end up with a file: point at one that already exists,
 * or bring a new one. Both finish the same way — a row the server confirmed.
 */
export function NoteFilePicker({
	onClose,
	onPick,
}: {
	onClose: () => void;
	onPick: (file: StoredFile) => void;
}) {
	const files = useStorageStore((state) => state.files);
	const status = useStorageStore((state) => state.status);
	const load = useStorageStore((state) => state.load);
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	const [uploadError, setUploadError] = useState<string>();
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		void load();
	}, [load]);

	const upload = async (selected: File[]) => {
		if (selected.length === 0) return;
		setUploadError(undefined);
		try {
			const [stored] = await uploadNoteFiles(selected, setUploads);
			if (!stored) {
				setUploadError('That file could not be uploaded. Try again.');
				return;
			}
			onPick(stored);
		} catch {
			setUploadError(
				navigator.onLine
					? 'That file could not be uploaded. Try again.'
					: 'Attaching a file requires a connection.',
			);
		} finally {
			setUploads([]);
		}
	};

	const transferring = uploads.filter(
		(item) => item.status === 'uploading' || item.status === 'pending',
	);
	const progress =
		transferring.length > 0
			? transferring.reduce((sum, item) => sum + item.progress, 0) /
				transferring.length
			: 0;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
				<DialogHeader className="border-b p-6 pb-4">
					<DialogTitle>Attach a file</DialogTitle>
					<DialogDescription>
						Pick one already in Storage, or upload a new one into{' '}
						{NOTES_UPLOAD_FOLDER}.
					</DialogDescription>
				</DialogHeader>

				<div className="border-b px-6 py-4">
					<input
						ref={inputRef}
						type="file"
						className="sr-only"
						aria-label="Choose a file to upload"
						onChange={(event) => {
							void upload([...(event.target.files ?? [])]);
							event.target.value = '';
						}}
					/>
					<Button
						variant="outline"
						className="w-full"
						disabled={transferring.length > 0}
						onClick={() => inputRef.current?.click()}
					>
						{transferring.length > 0 ? (
							<Spinner data-icon="inline-start" />
						) : (
							<UploadIcon data-icon="inline-start" />
						)}
						Upload a file
					</Button>
					{transferring.length > 0 ? (
						<Progress
							value={Math.round(progress * 100)}
							className="mt-3"
							aria-label="Upload progress"
						/>
					) : null}
					{uploadError ? (
						<p role="alert" className="mt-3 text-destructive text-sm">
							{uploadError}
						</p>
					) : null}
				</div>

				<Command className="rounded-none p-0" shouldFilter label="Stored files">
					{/* Focused on open: the dialog exists to find a file, and typing is
					    the fastest way to do that. */}
					<CommandInput
						autoFocus
						placeholder="Search stored files…"
						aria-label="Search stored files"
					/>
					<CommandList className="max-h-72">
						<CommandEmpty>
							{status === 'loading' ? 'Loading files…' : 'No matching files.'}
						</CommandEmpty>
						<CommandGroup heading="Stored files">
							{files.map((file) => {
								const Icon = fileTypeIcon(file.contentType);
								return (
									<CommandItem
										key={file.id}
										value={`${file.path ?? ''}/${file.name}`}
										onSelect={() => onPick(file)}
									>
										<Icon />
										<span className="min-w-0 flex-1 truncate">{file.name}</span>
										<span className="shrink-0 text-muted-foreground text-xs">
											{fileTypeLabel(file.contentType)} ·{' '}
											{formatBytes(file.size)}
										</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>

				<DialogFooter className="border-t p-6 pt-4">
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
