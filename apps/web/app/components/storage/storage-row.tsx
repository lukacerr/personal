import { useDraggable, useDroppable } from '@dnd-kit/react';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import { TableCell, TableRow } from '@web/components/ui/table';
import { fileTypeIcon, fileTypeLabel, formatBytes } from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { cn, timestampLabel } from '@web/lib/utils';
import {
	CheckIcon,
	ChevronLeftIcon,
	DownloadIcon,
	EyeIcon,
	FolderIcon,
	Globe2Icon,
	GripVerticalIcon,
	LockIcon,
	NotebookPenIcon,
	PencilIcon,
	Trash2Icon,
	XIcon,
} from 'lucide-react';
import { type MouseEvent, useEffect, useId, useState } from 'react';

/**
 * The rows of the desktop table, and the pieces both layouts share: what a
 * click on a row means, how a type reads, and the inline rename field.
 */

/**
 * Where windowing starts paying for itself, for both layouts: below this many
 * rows the measurement machinery costs more than it saves.
 */
export const VIRTUALISE_ABOVE = 120;

export type StorageActions = {
	onOpenFolder: (name: string) => void;
	onNavigatePath: (path: string | null) => void;
	onPreview: (file: StoredFile) => void;
	onDownload: (file: StoredFile) => void;
	onShare: (file: StoredFile) => void;
	onMove: (files: StoredFile[]) => void;
	onDelete: (file: StoredFile) => void;
	onDeleteFolder: (name: string) => void;
	onMoveFolder: (name: string) => void;
	onRenameFile: (file: StoredFile, name: string) => Promise<string | undefined>;
	onRenameFolder: (name: string, next: string) => Promise<string | undefined>;
};

/** The root is a real destination, and its path is the empty one. */
export function droppableId(path: string | null) {
	return `folder:${path ?? ''}`;
}

export function droppablePath(id: string) {
	return id.startsWith('folder:')
		? id.slice('folder:'.length) || null
		: undefined;
}

/**
 * A control, for the purpose of deciding who a click belongs to. Focusable
 * rather than `<button>` on purpose: Base UI renders a checkbox as a span with
 * a role and a tabindex, and a row that opened a file every time one was ticked
 * would be worse than a row that never opened at all.
 */
const ROW_CONTROLS =
	'a, button, input, label, select, textarea, [tabindex], [data-row-ignore]';

/**
 * Whether a click on a row means "open this". A click that landed on a control
 * belongs to that control, and a click that ends a text selection was someone
 * reading a filename rather than asking for it to be opened.
 *
 * The match has to sit inside the row. `closest` walks the entire ancestry, and
 * the app shell's `<main>` carries a tabindex of its own, so an unbounded lookup
 * finds a "control" above every row and nothing in the table opens at all.
 */
function activatesRow(event: MouseEvent<HTMLElement>) {
	const target = event.target as HTMLElement | null;
	const control = target?.closest(ROW_CONTROLS);
	if (control && event.currentTarget.contains(control)) return false;
	return !window.getSelection()?.toString();
}

export function composeRefs(...refs: Array<(element: Element | null) => void>) {
	return (element: Element | null) => {
		for (const ref of refs) ref(element);
	};
}

export function InlineRename({
	value,
	label,
	onSave,
	onCancel,
}: {
	value: string;
	label: string;
	onSave: (value: string) => Promise<string | undefined>;
	onCancel: () => void;
}) {
	const [name, setName] = useState(value);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const errorId = useId();

	useEffect(() => setName(value), [value]);

	const save = async () => {
		if (pending) return;
		setPending(true);
		setError(undefined);
		try {
			const failure = await onSave(name);
			if (failure) setError(failure);
			else onCancel();
		} finally {
			setPending(false);
		}
	};

	return (
		<form
			className="flex min-w-0 flex-1 items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<div className="min-w-0 flex-1">
				<Input
					autoFocus
					value={name}
					aria-label={label}
					aria-invalid={Boolean(error)}
					aria-describedby={error ? errorId : undefined}
					className="h-8"
					onFocus={(event) => event.currentTarget.select()}
					onChange={(event) => {
						setName(event.target.value);
						setError(undefined);
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							onCancel();
						}
					}}
				/>
				{error ? (
					<p
						id={errorId}
						role="alert"
						className="mt-1 text-destructive text-xs"
					>
						{error}
					</p>
				) : null}
			</div>
			<Button
				size="icon-xs"
				type="submit"
				disabled={pending}
				aria-label="Save name"
			>
				{pending ? <Spinner /> : <CheckIcon />}
			</Button>
			<Button
				size="icon-xs"
				type="button"
				variant="ghost"
				onClick={onCancel}
				aria-label="Cancel rename"
			>
				<XIcon />
			</Button>
		</form>
	);
}

/** The row above the current folder, and a destination in its own right. */
export function ParentDesktopRow({
	parentPath,
	disabled,
	onNavigatePath,
}: {
	parentPath: string | null;
	disabled: boolean;
	onNavigatePath: (path: string | null) => void;
}) {
	const { ref, isDropTarget } = useDroppable({
		id: droppableId(parentPath),
		disabled,
	});

	return (
		<TableRow
			ref={ref}
			className={cn(
				'cursor-pointer',
				isDropTarget && 'bg-muted ring-2 ring-ring/40 ring-inset',
			)}
			onClick={(event) => activatesRow(event) && onNavigatePath(parentPath)}
		>
			<TableCell />
			<TableCell />
			<TableCell colSpan={6}>
				<Button
					variant="ghost"
					onClick={() => onNavigatePath(parentPath)}
					aria-label="Go to parent folder"
				>
					<ChevronLeftIcon data-icon="inline-start" />
					<strong>..</strong>
					<span className="text-muted-foreground">Parent folder</span>
				</Button>
			</TableCell>
		</TableRow>
	);
}

export function FolderDesktopRow({
	name,
	path,
	editing,
	dropDisabled,
	actions,
	onEdit,
	onCancelEdit,
	onHandleClick,
}: {
	name: string;
	path: string;
	editing: boolean;
	dropDisabled: boolean;
	actions: StorageActions;
	onEdit: () => void;
	onCancelEdit: () => void;
	onHandleClick: () => void;
}) {
	const { ref: dropRef, isDropTarget } = useDroppable({
		id: droppableId(path),
		disabled: dropDisabled,
	});
	const {
		ref: dragRef,
		handleRef,
		isDragging,
	} = useDraggable({ id: `dir:${path}` });

	return (
		<TableRow
			ref={composeRefs(dropRef, dragRef)}
			className={cn(
				'cursor-pointer',
				isDragging && 'opacity-35',
				isDropTarget && 'bg-muted ring-2 ring-ring/40 ring-inset',
			)}
			onClick={(event) => activatesRow(event) && actions.onOpenFolder(name)}
		>
			<TableCell className="w-10 pr-0">
				<Button
					ref={handleRef}
					size="icon-sm"
					variant="ghost"
					onClick={onHandleClick}
					aria-label={`Move or drag folder ${name}`}
				>
					<GripVerticalIcon />
				</Button>
			</TableCell>
			<TableCell className="w-10 pr-0" />
			<TableCell className="min-w-64">
				{editing ? (
					<InlineRename
						value={name}
						label={`Rename folder ${name}`}
						onSave={(next) => actions.onRenameFolder(name, next)}
						onCancel={onCancelEdit}
					/>
				) : (
					<div className="flex min-w-0 items-center gap-1">
						<Button
							variant="ghost"
							className="min-w-0 justify-start"
							onClick={() => actions.onOpenFolder(name)}
						>
							<FolderIcon data-icon="inline-start" />
							<span className="truncate font-medium">{name}</span>
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							className="text-muted-foreground"
							onClick={onEdit}
							aria-label={`Rename folder ${name}`}
						>
							<PencilIcon />
						</Button>
					</div>
				)}
			</TableCell>
			<TableCell className="text-muted-foreground">Folder</TableCell>
			<TableCell />
			<TableCell />
			<TableCell />
			<TableCell className="text-right">
				<Button
					size="icon-sm"
					variant="ghost"
					onClick={() => actions.onDeleteFolder(name)}
					aria-label={`Delete folder ${name}`}
				>
					<Trash2Icon />
				</Button>
			</TableCell>
		</TableRow>
	);
}

export function FileDesktopRow({
	file,
	resultMode,
	selected,
	editing,
	actions,
	onToggle,
	onEdit,
	onCancelEdit,
	onHandleClick,
}: {
	file: StoredFile;
	resultMode: boolean;
	selected: boolean;
	editing: boolean;
	actions: StorageActions;
	onToggle: () => void;
	onEdit: () => void;
	onCancelEdit: () => void;
	onHandleClick: () => void;
}) {
	const Icon = fileTypeIcon(file.contentType);
	const { ref, handleRef, isDragging } = useDraggable({
		id: `file:${file.id}`,
	});

	return (
		<TableRow
			ref={ref}
			data-state={selected ? 'selected' : undefined}
			className={cn('cursor-pointer', isDragging && 'opacity-35')}
			onClick={(event) =>
				!editing && activatesRow(event) && actions.onPreview(file)
			}
		>
			<TableCell className="w-10 pr-0">
				<Button
					ref={handleRef}
					size="icon-sm"
					variant="ghost"
					onClick={onHandleClick}
					aria-label={`Move or drag ${file.name}`}
				>
					<GripVerticalIcon />
				</Button>
			</TableCell>
			<TableCell className="w-10 pr-0">
				<Checkbox
					checked={selected}
					onCheckedChange={onToggle}
					aria-label={`Select ${file.name}`}
				/>
			</TableCell>
			<TableCell className="min-w-72">
				<div className="flex items-center gap-2">
					<Icon className="size-5 shrink-0 text-muted-foreground" />
					{editing ? (
						<InlineRename
							value={file.name}
							label={`Rename ${file.name}`}
							onSave={(name) => actions.onRenameFile(file, name)}
							onCancel={onCancelEdit}
						/>
					) : (
						<div className="flex min-w-0 items-center gap-1">
							<div className="min-w-0">
								<Button
									variant="ghost"
									className="h-auto max-w-full justify-start px-1 py-1"
									onClick={() => actions.onPreview(file)}
								>
									<span className="truncate font-medium">{file.name}</span>
									{file.uploadedFromNotes ? (
										<NotebookPenIcon
											className="size-3.5 shrink-0 text-muted-foreground"
											aria-label="Uploaded from Notes"
										/>
									) : null}
								</Button>
								{resultMode ? (
									<Button
										size="xs"
										variant="ghost"
										className="block max-w-full truncate px-1 text-muted-foreground"
										onClick={() => actions.onNavigatePath(file.path)}
									>
										{file.path ?? 'Root'}
									</Button>
								) : null}
							</div>
							<Button
								size="icon-sm"
								variant="ghost"
								className="text-muted-foreground"
								onClick={onEdit}
								aria-label={`Rename ${file.name}`}
							>
								<PencilIcon />
							</Button>
						</div>
					)}
				</div>
			</TableCell>
			<TableCell className="text-muted-foreground">
				{fileTypeLabel(file.contentType)}
			</TableCell>
			<TableCell>{formatBytes(file.size)}</TableCell>
			<TableCell>
				<time dateTime={new Date(file.createdAt).toISOString()}>
					{timestampLabel(file.createdAt)}
				</time>
			</TableCell>
			<TableCell>
				{/* Sharing is what "access" means here, so the badge that states it is
				    also the control that changes it. */}
				<Badge
					variant="secondary"
					className="h-7 cursor-pointer gap-1 px-2.5 hover:bg-secondary/70"
					render={<button type="button" aria-label={`Share ${file.name}`} />}
					onClick={() => actions.onShare(file)}
				>
					{file.isPublic ? <Globe2Icon /> : <LockIcon />}
					{file.isPublic ? 'Public' : 'Private'}
				</Badge>
				{/* Only while public: the count describes the link, and next to a
				    Private badge it would read as views nobody can be having. */}
				{file.isPublic ? (
					<span className="ml-2 inline-flex items-center gap-1 text-muted-foreground text-xs">
						<EyeIcon className="size-3.5" aria-hidden="true" />
						{file.viewCount}
						<span className="sr-only">views</span>
					</span>
				) : null}
			</TableCell>
			<TableCell className="text-right">
				<Button
					size="icon-sm"
					variant="ghost"
					onClick={() => actions.onDownload(file)}
					aria-label={`Download ${file.name}`}
				>
					<DownloadIcon />
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					onClick={() => actions.onDelete(file)}
					aria-label={`Delete ${file.name}`}
				>
					<Trash2Icon />
				</Button>
			</TableCell>
		</TableRow>
	);
}
