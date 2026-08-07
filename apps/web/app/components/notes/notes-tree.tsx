import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import {
	DragDropProvider,
	DragOverlay,
	useDraggable,
	useDroppable,
} from '@dnd-kit/react';
import { NotesPreferencesControl } from '@web/components/notes/note-preferences';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import {
	buildNoteTree,
	collectFolderPaths,
	getActiveFolderPath,
	type NoteTreeFolder,
} from '@web/lib/notes';
import type { NoteSummary } from '@web/lib/notes-db';
import type {
	NotesPreferenceSize,
	NotesPreferences,
} from '@web/lib/notes-preferences';
import {
	BookOpenTextIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronsUpDownIcon,
	FilePlus2Icon,
	FileTextIcon,
	FolderIcon,
	GripVerticalIcon,
	PanelLeftCloseIcon,
	PencilIcon,
	RefreshCwIcon,
	Trash2Icon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

export type NoteMoveResult =
	| 'moved'
	| 'same'
	| 'conflict'
	| 'missing'
	| 'failed';

type NoteActions = {
	selectedId: string | null;
	editingNoteId: string | undefined;
	onSelect: (id: string) => void;
	onCreate: (path: string | null) => void;
	onEditNote: (id: string) => void;
	onCancelEditNote: () => void;
	onRenameNote: (
		note: NoteSummary,
		title: string,
	) => Promise<string | undefined>;
	onDeleteNote: (note: NoteSummary) => void;
};

function NoteTreeItem({
	note,
	selected,
	editing,
	actions,
}: {
	note: NoteSummary;
	selected: boolean;
	editing: boolean;
	actions: NoteActions;
}) {
	const [title, setTitle] = useState(note.title);
	const [error, setError] = useState('');
	const {
		ref: dragRef,
		handleRef,
		isDragging,
	} = useDraggable({ id: `note:${note.id}` });
	const actionVisibility = selected
		? 'opacity-100'
		: 'opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100';

	useEffect(() => {
		if (editing) {
			setTitle(note.title);
			setError('');
		}
	}, [editing, note.title]);

	const commit = async () => {
		const renameError = await actions.onRenameNote(note, title);
		if (renameError) {
			setError(renameError);
			return;
		}
		actions.onCancelEditNote();
	};

	return (
		<li>
			<div
				ref={dragRef}
				className={`group/note flex min-h-8 items-center gap-0.5 rounded-xl transition-colors ${isDragging ? 'opacity-40' : ''} ${selected ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted/70'}`}
			>
				{editing ? (
					<>
						<FileTextIcon className="ml-2 size-4 shrink-0 text-muted-foreground" />
						<Input
							value={title}
							onChange={(event) => {
								setTitle(event.target.value);
								setError('');
							}}
							onBlur={() => void commit()}
							onKeyDown={(event) => {
								if (event.key === 'Enter') void commit();
								if (event.key === 'Escape') actions.onCancelEditNote();
							}}
							autoFocus
							onFocus={(event) => event.currentTarget.select()}
							aria-label={`Rename ${note.title}`}
							aria-invalid={Boolean(error)}
							title={error || undefined}
							className="h-7 min-w-0 flex-1 rounded-lg px-1.5"
						/>
						<span className="sr-only" aria-live="polite">
							{error}
						</span>
					</>
				) : (
					<Button
						variant="ghost"
						size="sm"
						className="h-8 min-w-0 flex-1 justify-start gap-2 bg-transparent px-2 font-normal hover:bg-transparent dark:hover:bg-transparent"
						onClick={() => actions.onSelect(note.id)}
					>
						<FileTextIcon className="text-muted-foreground" />
						<span className="truncate">{note.title}</span>
					</Button>
				)}
				{!editing && (
					<>
						<Button
							ref={handleRef}
							variant="ghost"
							size="icon-xs"
							className={actionVisibility}
							aria-label={`Move ${note.title}`}
						>
							<GripVerticalIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							className={actionVisibility}
							onClick={() => actions.onEditNote(note.id)}
							aria-label={`Rename ${note.title}`}
						>
							<PencilIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							className={actionVisibility}
							onClick={() => actions.onDeleteNote(note)}
							aria-label={`Delete ${note.title}`}
						>
							<Trash2Icon />
						</Button>
					</>
				)}
			</div>
		</li>
	);
}

function FolderBranch({
	folder,
	activeFolderPath,
	expandedPaths,
	onToggle,
	onRenameFolder,
	onDeleteFolder,
	actions,
}: {
	folder: NoteTreeFolder;
	activeFolderPath: string | undefined;
	expandedPaths: Set<string>;
	onToggle: (path: string) => void;
	onRenameFolder: (path: string) => void;
	onDeleteFolder: (path: string) => void;
	actions: NoteActions;
}) {
	const open = expandedPaths.has(folder.path);
	const active = activeFolderPath === folder.path;
	const { ref: dropRef, isDropTarget } = useDroppable({
		id: `folder:${folder.path}`,
	});
	const actionVisibility = active
		? 'opacity-100'
		: 'opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100';

	return (
		<li>
			<div
				ref={dropRef}
				className={`group/folder flex items-center gap-0.5 rounded-xl transition-colors ${isDropTarget ? 'bg-muted ring-1 ring-ring' : active ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted/70'}`}
			>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 min-w-0 flex-1 justify-start gap-1.5 bg-transparent px-1.5 text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent"
					onClick={() => onToggle(folder.path)}
					aria-expanded={open}
				>
					{open ? <ChevronDownIcon /> : <ChevronRightIcon />}
					<FolderIcon />
					<span className="truncate">{folder.name}</span>
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					className={actionVisibility}
					onClick={() => actions.onCreate(folder.path)}
					aria-label={`New note in ${folder.path}`}
				>
					<FilePlus2Icon />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					className={actionVisibility}
					onClick={() => onRenameFolder(folder.path)}
					aria-label={`Rename ${folder.path}`}
				>
					<PencilIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					className={actionVisibility}
					onClick={() => onDeleteFolder(folder.path)}
					aria-label={`Delete ${folder.path}`}
				>
					<Trash2Icon />
				</Button>
			</div>
			{open && (
				<ul className="ml-3 border-l border-border/60 pl-2">
					{folder.folders.map((child) => (
						<FolderBranch
							key={child.path}
							folder={child}
							activeFolderPath={activeFolderPath}
							expandedPaths={expandedPaths}
							onToggle={onToggle}
							onRenameFolder={onRenameFolder}
							onDeleteFolder={onDeleteFolder}
							actions={actions}
						/>
					))}
					{folder.notes.map((note) => (
						<NoteTreeItem
							key={note.id}
							note={note}
							selected={note.id === actions.selectedId}
							editing={note.id === actions.editingNoteId}
							actions={actions}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function RootDropTarget({ visible }: { visible: boolean }) {
	const { ref, isDropTarget } = useDroppable({ id: 'root' });
	if (!visible) return null;
	return (
		<div
			ref={ref}
			className={`mb-2 flex h-9 items-center gap-2 rounded-xl border border-dashed px-3 text-xs transition-colors ${isDropTarget ? 'border-ring bg-muted text-foreground' : 'text-muted-foreground'}`}
		>
			<FolderIcon /> Move to Root
		</div>
	);
}

const moveAnnouncements: Record<NoteMoveResult, string> = {
	moved: '',
	same: 'Note is already in that folder.',
	conflict: 'A note with that title already exists there.',
	missing: 'Could not move note.',
	failed: 'Could not move note.',
};

export function NotesTree({
	notes,
	selectedId,
	preferences,
	setPreference,
	refreshing,
	onRefresh,
	onSelect,
	onCreate,
	onCollapse,
	onRenameNote,
	onDeleteNote,
	onRenameFolder,
	onDeleteFolder,
	onMoveNote,
}: {
	notes: NoteSummary[];
	selectedId: string | null;
	preferences: NotesPreferences;
	setPreference: (
		key: keyof NotesPreferences,
		value: NotesPreferenceSize,
	) => void;
	refreshing: boolean;
	onRefresh: () => void;
	onSelect: (id: string) => void;
	onCreate: (path: string | null) => void;
	onCollapse?: () => void;
	onRenameNote: (
		note: NoteSummary,
		title: string,
	) => Promise<string | undefined>;
	onDeleteNote: (note: NoteSummary) => void;
	onRenameFolder: (path: string) => void;
	onDeleteFolder: (path: string) => void;
	onMoveNote: (id: string, path: string | null) => Promise<NoteMoveResult>;
}) {
	const tree = useMemo(() => buildNoteTree(notes), [notes]);
	const folderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
	const folderPathsKey = folderPaths.join('\0');
	const activeFolderPath = getActiveFolderPath(notes, selectedId);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
	const [editingNoteId, setEditingNoteId] = useState<string>();
	const [draggedId, setDraggedId] = useState<string>();
	const [dragAnnouncement, setDragAnnouncement] = useState('');
	const knownFolderPaths = useRef(new Set<string>());

	useEffect(() => {
		const paths = folderPathsKey ? folderPathsKey.split('\0') : [];
		const validPaths = new Set(paths);
		const appeared = paths.filter(
			(path) => !knownFolderPaths.current.has(path),
		);
		knownFolderPaths.current = validPaths;
		setExpandedPaths((current) => {
			const next = new Set([...current].filter((path) => validPaths.has(path)));
			for (const path of appeared) next.add(path);
			return next;
		});
	}, [folderPathsKey]);

	useEffect(() => {
		if (!activeFolderPath) return;
		const parts = activeFolderPath.split('/');
		setExpandedPaths((current) => {
			const next = new Set(current);
			for (let index = 1; index <= parts.length; index += 1)
				next.add(parts.slice(0, index).join('/'));
			return next;
		});
	}, [activeFolderPath]);

	const toggleFolder = (path: string) =>
		setExpandedPaths((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	const toggleAllFolders = () =>
		setExpandedPaths((current) =>
			current.size > 0 ? new Set() : new Set(folderPaths),
		);
	const allFoldersCollapsed = expandedPaths.size === 0;
	const draggedNote = notes.find((note) => note.id === draggedId);
	const actions: NoteActions = {
		selectedId,
		editingNoteId,
		onSelect,
		onCreate,
		onEditNote: (id) => {
			onSelect(id);
			setEditingNoteId(id);
		},
		onCancelEditNote: () => setEditingNoteId(undefined),
		onRenameNote,
		onDeleteNote,
	};

	const endDrag = async (operation: {
		source: { id: string | number } | null;
		target: { id: string | number } | null;
	}) => {
		const source = String(operation.source?.id ?? '');
		const target = String(operation.target?.id ?? '');
		setDraggedId(undefined);
		if (
			!source.startsWith('note:') ||
			(!target.startsWith('folder:') && target !== 'root')
		) {
			setDragAnnouncement('Move canceled.');
			return;
		}
		const noteId = source.slice('note:'.length);
		const path = target === 'root' ? null : target.slice('folder:'.length);
		const result = await onMoveNote(noteId, path);
		setDragAnnouncement(
			result === 'moved'
				? `Moved note to ${path ?? 'Root'}.`
				: moveAnnouncements[result],
		);
		// A failed move used to be visible only to screen readers.
		if (result !== 'moved') toast.error(moveAnnouncements[result]);
	};

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
				const id = String(operation.source?.id ?? '').replace(/^note:/, '');
				setDraggedId(id || undefined);
				const title = notes.find((note) => note.id === id)?.title ?? 'note';
				setDragAnnouncement(`Moving ${title}.`);
			}}
			onDragEnd={({ operation, canceled }) => {
				if (canceled) {
					setDraggedId(undefined);
					setDragAnnouncement('Move canceled.');
					return;
				}
				void endDrag(operation);
			}}
		>
			<div className="flex h-full min-h-0 flex-col overflow-hidden bg-card/45">
				<div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
					<div className="min-w-0 flex-1">
						<p className="font-heading text-sm font-semibold">Notes</p>
						<p className="truncate text-[0.68rem] text-muted-foreground">
							{notes.length} {notes.length === 1 ? 'document' : 'documents'}
						</p>
					</div>
					<Button
						size="icon-sm"
						variant="ghost"
						onClick={onRefresh}
						disabled={refreshing}
						aria-busy={refreshing}
						aria-label="Refresh from server"
					>
						{refreshing ? <Spinner /> : <RefreshCwIcon />}
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						onClick={toggleAllFolders}
						disabled={folderPaths.length === 0}
						aria-label={
							allFoldersCollapsed
								? 'Expand all folders'
								: 'Collapse all folders'
						}
					>
						<ChevronsUpDownIcon />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						onClick={() => onCreate(null)}
						aria-label="New note"
						aria-keyshortcuts="Control+N"
					>
						<FilePlus2Icon />
					</Button>
					{onCollapse && (
						<Button
							size="icon-sm"
							variant="ghost"
							onClick={onCollapse}
							aria-label="Collapse notes tree"
							aria-keyshortcuts="Control+Alt+B"
						>
							<PanelLeftCloseIcon />
						</Button>
					)}
				</div>
				<nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Notes">
					<RootDropTarget visible={Boolean(draggedId)} />
					{notes.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
							<BookOpenTextIcon className="size-8 text-muted-foreground/60" />
							<div>
								<p className="text-sm font-medium">No notes yet</p>
								<p className="mt-1 text-xs leading-5 text-muted-foreground">
									Create one here. It will stay local until you save.
								</p>
							</div>
							<Button size="sm" onClick={() => onCreate(null)}>
								<FilePlus2Icon /> New note
							</Button>
						</div>
					) : (
						<ul className="space-y-0.5">
							{tree.folders.map((folder) => (
								<FolderBranch
									key={folder.path}
									folder={folder}
									activeFolderPath={activeFolderPath}
									expandedPaths={expandedPaths}
									onToggle={toggleFolder}
									onRenameFolder={onRenameFolder}
									onDeleteFolder={onDeleteFolder}
									actions={actions}
								/>
							))}
							{tree.notes.map((note) => (
								<NoteTreeItem
									key={note.id}
									note={note}
									selected={note.id === selectedId}
									editing={note.id === editingNoteId}
									actions={actions}
								/>
							))}
						</ul>
					)}
				</nav>
				<div className="shrink-0 border-t p-2">
					<NotesPreferencesControl
						preferences={preferences}
						setPreference={setPreference}
					/>
				</div>
				<p className="sr-only" aria-live="assertive">
					{dragAnnouncement}
				</p>
			</div>
			<DragOverlay dropAnimation={{ duration: 120, easing: 'ease-out' }}>
				{draggedNote ? (
					<div className="flex h-8 max-w-64 items-center gap-2 rounded-xl bg-popover px-3 text-sm shadow-lg ring-1 ring-border">
						<FileTextIcon />
						<span className="truncate">{draggedNote.title}</span>
					</div>
				) : null}
			</DragOverlay>
		</DragDropProvider>
	);
}
