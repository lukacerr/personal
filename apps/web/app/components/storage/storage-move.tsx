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
import { Spinner } from '@web/components/ui/spinner';
import {
	canDropFolder,
	normalizeStoragePath,
	parentFolder,
	validateStoragePath,
} from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { CheckIcon, FolderIcon, FolderPlusIcon, HouseIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Moving files and moving a folder land on the same question — which path —
 * so they share the dialog. What differs is where they start from and which
 * destinations make sense: a folder cannot be moved inside itself.
 */
export type StorageMoveTarget =
	| { kind: 'files'; files: StoredFile[] }
	| { kind: 'folder'; name: string; path: string };

function describe(target: StorageMoveTarget) {
	if (target.kind === 'folder') return `Move folder ${target.name}`;
	return target.files.length === 1
		? `Move ${target.files[0]?.name}`
		: `Move ${target.files.length} files`;
}

/** Where the target already is, so the dialog can refuse to move it nowhere. */
function originOf(target: StorageMoveTarget | undefined) {
	if (!target) return null;
	if (target.kind === 'folder') return parentFolder(target.path);
	return target.files.every((file) => file.path === target.files[0]?.path)
		? (target.files[0]?.path ?? null)
		: undefined;
}

export function StorageMove({
	target,
	folders,
	onClose,
	onMove,
}: {
	target: StorageMoveTarget | undefined;
	folders: Array<string | null>;
	onClose: () => void;
	onMove: (path: string | null) => Promise<string | undefined>;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const open = target !== undefined;
	const origin = originOf(target);
	const normalizedQuery = normalizeStoragePath(query);
	const pathError = query ? validateStoragePath(query) : undefined;

	const allowed = (path: string | null) =>
		target?.kind !== 'folder' || canDropFolder(target.path, path);
	const destinations = folders.filter(allowed);
	const queryIsNew =
		Boolean(normalizedQuery) &&
		!pathError &&
		allowed(normalizedQuery) &&
		!folders.some(
			(path) =>
				(path ?? '').toLocaleLowerCase() ===
				(normalizedQuery ?? '').toLocaleLowerCase(),
		);

	useEffect(() => {
		setSelected(origin ?? null);
		setQuery('');
		setError(undefined);
	}, [origin]);

	const move = async () => {
		if (pending || selected === origin) return;
		setPending(true);
		setError(undefined);
		try {
			const failure = await onMove(selected);
			if (failure) setError(failure);
			else onClose();
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
				<DialogHeader className="border-b p-6 pb-4">
					<DialogTitle>{target ? describe(target) : 'Move'}</DialogTitle>
					<DialogDescription>
						Choose an existing path or type a new one. The path starts existing
						when this moves there.
					</DialogDescription>
				</DialogHeader>

				<Command
					className="rounded-none p-0"
					shouldFilter
					label="Destination path"
				>
					<CommandInput
						value={query}
						onValueChange={(value) => {
							setQuery(value);
							setError(undefined);
						}}
						placeholder="Full path from Storage root…"
						aria-label="Destination path"
					/>
					<CommandList className="max-h-80">
						<CommandEmpty>
							{pathError ?? 'No matching folders. Type a valid new path.'}
						</CommandEmpty>
						{queryIsNew ? (
							<CommandGroup heading="New destination">
								<CommandItem
									value={query}
									onSelect={() => {
										setSelected(normalizedQuery);
										setError(undefined);
									}}
								>
									<FolderPlusIcon />
									Move to new path “{normalizedQuery}”
									{selected === normalizedQuery ? <CheckIcon /> : null}
								</CommandItem>
							</CommandGroup>
						) : null}
						<CommandGroup heading="Destinations">
							{destinations.map((path) => (
								<CommandItem
									key={path ?? 'root'}
									value={path ?? 'Root'}
									aria-selected={selected === path}
									onSelect={() => {
										setSelected(path);
										setError(undefined);
									}}
								>
									{path ? <FolderIcon /> : <HouseIcon />}
									<span className="min-w-0 flex-1 truncate">
										{path ?? 'Root'}
									</span>
									{selected === path ? <CheckIcon /> : null}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>

				<div className="border-t p-6 pt-4">
					{error ? (
						<p role="alert" className="mb-3 text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button
							disabled={pending || selected === origin}
							onClick={() => void move()}
						>
							{pending ? <Spinner data-icon="inline-start" /> : null}
							Move here
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
