import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, DragOverlay } from '@dnd-kit/react';
import { StorageCards } from '@web/components/storage/storage-cards';
import {
	droppablePath,
	FileDesktopRow,
	FolderDesktopRow,
	ParentDesktopRow,
	type StorageActions,
} from '@web/components/storage/storage-row';
import { Checkbox } from '@web/components/ui/checkbox';
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from '@web/components/ui/table';
import {
	canDropFolder,
	type FileMoveResult,
	joinPath,
	parentFolder,
} from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { FileIcon, FolderIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

/** What is being dragged, read back from the id the drag was started with. */
type DragSource =
	| { kind: 'file'; files: StoredFile[] }
	| { kind: 'folder'; name: string; path: string };

export function StorageList({
	folders,
	files,
	currentFolder,
	resultMode,
	selectedIds,
	onToggleSelected,
	onSelectAll,
	onOpenFolder,
	onNavigatePath,
	onPreview,
	onDownload,
	onShare,
	onMove,
	onDelete,
	onRenameFile,
	onRenameFolder,
	onDeleteFolder,
	onMoveFolder,
	onDropFiles,
	onDropFolder,
}: {
	folders: string[];
	files: StoredFile[];
	currentFolder: string | null;
	resultMode: boolean;
	selectedIds: Set<string>;
	onToggleSelected: (id: string) => void;
	onSelectAll: () => void;
	onOpenFolder: (name: string) => void;
	onNavigatePath: (path: string | null) => void;
	onPreview: (file: StoredFile) => void;
	onDownload: (file: StoredFile) => void;
	onShare: (file: StoredFile) => void;
	onMove: (files: StoredFile[]) => void;
	onDelete: (file: StoredFile) => void;
	onRenameFile: StorageActions['onRenameFile'];
	onRenameFolder: StorageActions['onRenameFolder'];
	onDeleteFolder: (name: string) => void;
	onMoveFolder: (name: string) => void;
	onDropFiles: (
		files: StoredFile[],
		path: string | null,
	) => Promise<FileMoveResult>;
	onDropFolder: (name: string, path: string | null) => Promise<FileMoveResult>;
}) {
	const [editing, setEditing] = useState<string>();
	const [dragging, setDragging] = useState<DragSource>();
	const [announcement, setAnnouncement] = useState('');
	const suppressClick = useRef(false);
	const selectedFiles = files.filter((file) => selectedIds.has(file.id));
	const allSelected =
		files.length > 0 && files.every((file) => selectedIds.has(file.id));
	const someSelected = files.some((file) => selectedIds.has(file.id));
	const parentPath = parentFolder(currentFolder);
	const actions: StorageActions = {
		onOpenFolder,
		onNavigatePath,
		onPreview,
		onDownload,
		onShare,
		onMove,
		onDelete,
		onDeleteFolder,
		onMoveFolder,
		onRenameFile,
		onRenameFolder,
	};

	/** A folder cannot be dropped onto itself, into its own subtree or where it is. */
	const dropDisabled = (path: string | null) =>
		dragging?.kind === 'folder' && !canDropFolder(dragging.path, path);

	const readSource = (id: string): DragSource | undefined => {
		if (id.startsWith('dir:')) {
			const path = id.slice('dir:'.length);
			return { kind: 'folder', name: path.split('/').at(-1) ?? path, path };
		}
		const fileId = id.slice('file:'.length);
		const file = files.find((entry) => entry.id === fileId);
		if (!file) return undefined;
		// Dragging one of several selected files carries the whole selection.
		return {
			kind: 'file',
			files:
				selectedIds.has(file.id) && selectedFiles.length > 1
					? selectedFiles
					: [file],
		};
	};

	const describe = (source: DragSource) =>
		source.kind === 'folder'
			? source.name
			: source.files.length === 1
				? (source.files[0]?.name ?? 'file')
				: `${source.files.length} files`;

	const endDrag = async (
		source: DragSource,
		operation: { target: { id: string | number } | null },
	) => {
		const path = droppablePath(String(operation.target?.id ?? ''));
		if (path === undefined) return;

		const result =
			source.kind === 'folder'
				? await onDropFolder(source.name, path)
				: await onDropFiles(source.files, path);
		const label = describe(source);
		const where = path ?? 'Root';
		const message =
			result === 'moved'
				? `Moved ${label} to ${where}.`
				: result === 'conflict'
					? `${label} could not be moved: a name is already taken in ${where}.`
					: result === 'same'
						? `${label} already there.`
						: `${label} could not be moved.`;

		setAnnouncement(message);
		if (result === 'moved') toast.success(message);
		else if (result !== 'same') toast.error(message);
	};

	const empty = folders.length === 0 && files.length === 0;

	return (
		<DragDropProvider
			sensors={(defaults) => [
				...defaults.filter((sensor) => sensor !== PointerSensor),
				PointerSensor.configure({
					activationConstraints(event) {
						return event.pointerType === 'touch'
							? [
									new PointerActivationConstraints.Delay({
										value: 250,
										tolerance: 6,
									}),
								]
							: [new PointerActivationConstraints.Distance({ value: 6 })];
					},
				}),
			]}
			onDragStart={({ operation }) => {
				const source = readSource(String(operation.source?.id ?? ''));
				setDragging(source);
				if (source) setAnnouncement(`Moving ${describe(source)}.`);
			}}
			onDragEnd={({ operation, canceled }) => {
				const source = dragging;
				setDragging(undefined);
				// The pointer that finished a drag also fires a click on whatever it
				// was released over, which is not a request to open anything.
				suppressClick.current = true;
				window.setTimeout(() => {
					suppressClick.current = false;
				}, 0);
				if (canceled || !source) return;
				void endDrag(source, operation);
			}}
		>
			<div className="hidden overflow-hidden rounded-xl border bg-card md:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-10">
								<span className="sr-only">Move</span>
							</TableHead>
							<TableHead className="w-10">
								<Checkbox
									checked={allSelected}
									indeterminate={!allSelected && someSelected}
									onCheckedChange={onSelectAll}
									aria-label="Select all visible files"
								/>
							</TableHead>
							<TableHead scope="col">Name</TableHead>
							<TableHead scope="col">Type</TableHead>
							<TableHead scope="col">Size</TableHead>
							<TableHead scope="col">Uploaded</TableHead>
							<TableHead scope="col">Access</TableHead>
							<TableHead scope="col" className="text-right">
								Actions
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentFolder && !resultMode ? (
							<ParentDesktopRow
								parentPath={parentPath}
								disabled={dropDisabled(parentPath)}
								onNavigatePath={onNavigatePath}
							/>
						) : null}
						{folders.map((name) => {
							const path = joinPath(currentFolder, name);
							return (
								<FolderDesktopRow
									key={name}
									name={name}
									path={path}
									editing={editing === `folder:${name}`}
									dropDisabled={dropDisabled(path)}
									actions={actions}
									onEdit={() => setEditing(`folder:${name}`)}
									onCancelEdit={() => setEditing(undefined)}
									onHandleClick={() => {
										if (!suppressClick.current) onMoveFolder(name);
									}}
								/>
							);
						})}
						{files.map((file) => {
							const group =
								selectedIds.has(file.id) && selectedFiles.length > 1
									? selectedFiles
									: [file];
							return (
								<FileDesktopRow
									key={file.id}
									file={file}
									resultMode={resultMode}
									selected={selectedIds.has(file.id)}
									editing={editing === `file:${file.id}`}
									actions={actions}
									onToggle={() => onToggleSelected(file.id)}
									onEdit={() => setEditing(`file:${file.id}`)}
									onCancelEdit={() => setEditing(undefined)}
									onHandleClick={() => {
										if (!suppressClick.current) onMove(group);
									}}
								/>
							);
						})}
					</TableBody>
				</Table>
			</div>

			<StorageCards
				folders={folders}
				files={files}
				currentFolder={currentFolder}
				resultMode={resultMode}
				selectedIds={selectedIds}
				actions={actions}
				onToggle={onToggleSelected}
			/>

			{empty && !(currentFolder && !resultMode) ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center">
					<FolderIcon className="size-10 text-muted-foreground" />
					<p className="font-medium">
						{resultMode ? 'No matches' : 'This folder is empty'}
					</p>
					<p className="text-muted-foreground text-sm">
						{resultMode
							? 'Try a different title, path or filter.'
							: 'Drop files here, or use Upload.'}
					</p>
				</div>
			) : null}

			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
			<DragOverlay dropAnimation={{ duration: 120, easing: 'ease-out' }}>
				{dragging ? (
					<div className="flex max-w-72 items-center gap-2 rounded-xl bg-popover px-4 py-3 text-sm shadow-lg ring-1 ring-border">
						{dragging.kind === 'folder' ? <FolderIcon /> : <FileIcon />}
						<span className="truncate">{describe(dragging)}</span>
					</div>
				) : null}
			</DragOverlay>
		</DragDropProvider>
	);
}
