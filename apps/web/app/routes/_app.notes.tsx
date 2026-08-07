import { NoteDocument } from '@web/components/notes/note-document';
import {
	type NoteMoveResult,
	NotesTree,
} from '@web/components/notes/notes-tree';
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
import { Input } from '@web/components/ui/input';
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@web/components/ui/sheet';
import { Spinner } from '@web/components/ui/spinner';
import { useIsMobile } from '@web/hooks/use-mobile';
import { authenticatedApi } from '@web/lib/authenticated-api';
import { usePwaAvailability } from '@web/lib/availability';
import {
	getLastSelectedNoteId,
	getNoteMoveResult,
	hasDuplicateNoteTitle,
	isNewNoteShortcut,
	isNotesTreeShortcut,
	rememberSelectedNote,
} from '@web/lib/notes';
import {
	createLocalNote,
	deleteLocalFolder,
	deleteLocalNote,
	type NoteSummary,
	notesDb,
	renameLocalFolder,
} from '@web/lib/notes-db';
import { normalizePath } from '@web/lib/notes-editor';
import { useNotesPreferences } from '@web/lib/notes-preferences';
import { describeNotesFailure } from '@web/lib/notes-refresh';
import {
	fetchRemoteNote,
	refreshNoteIndex,
	refreshNotes,
	updateAndSyncNoteMetadata,
} from '@web/lib/notes-sync';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	BookOpenTextIcon,
	FilePlus2Icon,
	PanelLeftOpenIcon,
} from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

type FolderAction = {
	type: 'rename' | 'delete';
	path: string;
	value: string;
	error?: string;
};

type NoteDeletion = { note: NoteSummary; error?: string };

export function meta() {
	return [{ title: 'Notes · Personal' }];
}

export default function Notes() {
	const [searchParams, setSearchParams] = useSearchParams();
	const isMobile = useIsMobile();
	const isOnline = usePwaAvailability() === 'online';
	const { preferences, setPreference } = useNotesPreferences();
	// Two independent states on purpose. `useIsMobile` reports desktop on the
	// first render, so a shared flag would open the phone drawer and then try to
	// close it in the same tick, leaving its backdrop stuck over the document.
	// The drawer therefore only ever opens from an explicit action.
	const [railOpen, setRailOpen] = useState(true);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const treeOpen = isMobile ? drawerOpen : railOpen;
	const setTreeOpen = (open: boolean) =>
		isMobile ? setDrawerOpen(open) : setRailOpen(open);
	const [titleFocusId, setTitleFocusId] = useState<string>();
	const [refreshing, setRefreshing] = useState(false);
	const [folderAction, setFolderAction] = useState<FolderAction>();
	const [noteDeletion, setNoteDeletion] = useState<NoteDeletion>();
	const notes = useLiveQuery(
		() => notesDb.notes.orderBy('title').toArray(),
		[],
		[],
	);
	const selectedId = searchParams.get('note');
	const selectedState = useLiveQuery(async () => {
		if (!selectedId) return undefined;
		const [note, pendingCount] = await Promise.all([
			notesDb.notes.get(selectedId),
			notesDb.outbox.where('noteId').equals(selectedId).count(),
		]);
		return { id: selectedId, note, pendingCount };
	}, [selectedId]);
	const selectedStateIsCurrent = selectedState?.id === selectedId;
	const selectedNote = selectedStateIsCurrent ? selectedState.note : undefined;
	const selectedPendingCount = selectedStateIsCurrent
		? selectedState.pendingCount
		: 0;
	const shouldFetchSelectedNote = Boolean(
		selectedNote &&
			selectedPendingCount === 0 &&
			(!selectedNote.dirty ||
				!selectedNote.content ||
				selectedNote.updatedAt >
					(selectedNote.draftUpdatedAt ?? selectedNote.updatedAt)),
	);

	useEffect(() => {
		if (selectedId || notes.length === 0) return;
		const remembered = getLastSelectedNoteId(notes, window.localStorage);
		if (remembered) setSearchParams({ note: remembered }, { replace: true });
	}, [notes, selectedId, setSearchParams]);

	useEffect(() => {
		if (!selectedId || !notes.some((note) => note.id === selectedId)) return;
		rememberSelectedNote(window.localStorage, selectedId);
	}, [notes, selectedId]);

	useEffect(() => {
		if (!selectedId || !shouldFetchSelectedNote) return;
		void fetchRemoteNote(selectedId).catch((error: unknown) => {
			toast.error(describeNotesFailure({ status: 'failed', error }));
		});
	}, [selectedId, shouldFetchSelectedNote]);

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		const result = await refreshNotes(selectedId ?? undefined);
		setRefreshing(false);
		if (result.status !== 'refreshed')
			toast.error(describeNotesFailure(result));
	};

	const selectNote = (id: string) => {
		rememberSelectedNote(window.localStorage, id);
		setSearchParams({ note: id });
		if (isMobile) setTreeOpen(false);
	};

	const createNote = async (path: string | null) => {
		const created = await createLocalNote(notesDb, path);
		setTitleFocusId(created.id);
		selectNote(created.id);
	};

	const renameNote = async (note: NoteSummary, title: string) => {
		const normalizedTitle = title.trim();
		if (!normalizedTitle) return 'A note title cannot be empty.';
		if (hasDuplicateNoteTitle(notes, note.id, normalizedTitle, note.path))
			return 'A note with this title already exists in this folder.';
		await updateAndSyncNoteMetadata(note.id, {
			title: normalizedTitle,
			path: note.path,
		});
		return undefined;
	};

	const moveNote = async (
		id: string,
		path: string | null,
	): Promise<NoteMoveResult> => {
		const result = getNoteMoveResult(notes, id, path);
		if (result.status !== 'move') return result.status;
		const moving = notes.find((note) => note.id === id);
		if (!moving) return 'missing';
		try {
			await updateAndSyncNoteMetadata(id, { title: moving.title, path });
			return 'moved';
		} catch {
			return 'failed';
		}
	};

	const selectAfterRemoval = (removedIds: string[]) => {
		if (!selectedId || !removedIds.includes(selectedId)) return;
		const next = notes.find((note) => !removedIds.includes(note.id));
		if (next) {
			rememberSelectedNote(window.localStorage, next.id);
			setSearchParams({ note: next.id });
		} else setSearchParams({});
	};

	const confirmDeleteNote = async () => {
		if (!noteDeletion) return;
		if (!isOnline) {
			setNoteDeletion({
				...noteDeletion,
				error: 'Deleting a note requires a connection.',
			});
			return;
		}
		const { note } = noteDeletion;
		const response = await authenticatedApi.notes({ id: note.id }).delete();
		if (response.status !== 204) {
			setNoteDeletion({
				...noteDeletion,
				error: 'The server could not delete this note.',
			});
			return;
		}
		await deleteLocalNote(notesDb, note.id);
		selectAfterRemoval([note.id]);
		setNoteDeletion(undefined);
		void refreshNoteIndex().catch((error: unknown) => {
			toast.error(describeNotesFailure({ status: 'failed', error }));
		});
	};

	const createNoteFromShortcut = useEffectEvent(() => createNote(null));
	// The Sheet closes itself on Escape, so only the explicit shortcut is handled.
	const toggleTree = useEffectEvent(() => setTreeOpen(!treeOpen));

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isNewNoteShortcut(event)) {
				event.preventDefault();
				event.stopPropagation();
				void createNoteFromShortcut();
				return;
			}
			if (!isNotesTreeShortcut(event)) return;
			event.preventDefault();
			event.stopPropagation();
			toggleTree();
		};
		document.addEventListener('keydown', handleKeyDown, true);
		return () => document.removeEventListener('keydown', handleKeyDown, true);
	}, []);

	const applyFolderAction = async () => {
		if (!folderAction) return;
		if (!isOnline) {
			setFolderAction({
				...folderAction,
				error: 'Folder operations require a connection.',
			});
			return;
		}

		if (folderAction.type === 'rename') {
			const to = normalizePath(folderAction.value);
			if (!to) {
				setFolderAction({
					...folderAction,
					error: 'Enter a destination path.',
				});
				return;
			}
			const response = await authenticatedApi.notes.folders.patch({
				from: folderAction.path,
				to,
			});
			if (response.status !== 200) {
				setFolderAction({
					...folderAction,
					error: 'That destination contains a conflicting note.',
				});
				return;
			}
			await renameLocalFolder(notesDb, folderAction.path, to);
		} else {
			const response = await authenticatedApi.notes.folders.delete({
				path: folderAction.path,
			});
			if (response.status !== 200) {
				setFolderAction({
					...folderAction,
					error: 'The server could not delete this folder.',
				});
				return;
			}
			const deletedIds = await deleteLocalFolder(notesDb, folderAction.path);
			selectAfterRemoval(deletedIds);
		}

		setFolderAction(undefined);
	};

	const tree = (
		<NotesTree
			notes={notes}
			selectedId={selectedId}
			preferences={preferences}
			setPreference={setPreference}
			refreshing={refreshing}
			onRefresh={() => void refresh()}
			onSelect={selectNote}
			onCreate={(path) => void createNote(path)}
			onCollapse={() => setTreeOpen(false)}
			onRenameNote={renameNote}
			onDeleteNote={(note) => setNoteDeletion({ note })}
			onRenameFolder={(path) =>
				setFolderAction({ type: 'rename', path, value: path })
			}
			onDeleteFolder={(path) =>
				setFolderAction({ type: 'delete', path, value: path })
			}
			onMoveNote={moveNote}
		/>
	);

	return (
		<div className="relative flex h-[calc(100dvh-4rem)] max-h-[calc(100dvh-4rem)] min-h-0 w-full flex-none overflow-hidden bg-background">
			{!isMobile && (
				<aside
					className={`h-full min-h-0 shrink-0 overflow-hidden border-r transition-[width,opacity,border-color] duration-100 ease-linear motion-reduce:transition-none ${treeOpen ? 'w-72 opacity-100' : 'pointer-events-none w-0 border-transparent opacity-0'}`}
					inert={!treeOpen}
				>
					<div className="h-full w-72">{tree}</div>
				</aside>
			)}
			{isMobile && (
				<Sheet open={treeOpen} onOpenChange={setTreeOpen}>
					<SheetContent
						side="left"
						className="w-[min(88vw,22rem)] gap-0 p-0 sm:max-w-sm"
					>
						<SheetHeader className="sr-only">
							<SheetTitle>Notes tree</SheetTitle>
							<SheetDescription>
								Browse folders and open a note.
							</SheetDescription>
						</SheetHeader>
						{tree}
					</SheetContent>
				</Sheet>
			)}
			{!treeOpen && (
				<Button
					variant="outline"
					size="icon-sm"
					className="absolute top-3 left-3 z-20 bg-background/90 shadow-sm"
					onClick={() => setTreeOpen(true)}
					aria-label="Open notes tree"
					aria-keyshortcuts="Control+Alt+B"
				>
					<PanelLeftOpenIcon />
				</Button>
			)}

			{selectedNote?.content ? (
				<NoteDocument
					key={selectedNote.id}
					note={selectedNote}
					preferences={preferences}
					focusTitle={selectedNote.id === titleFocusId}
					treeOpen={treeOpen}
					refreshing={refreshing}
					onRefresh={() => void refresh()}
					onTitleFocused={() => setTitleFocusId(undefined)}
					onRequestDelete={() => setNoteDeletion({ note: selectedNote })}
					isTitleTaken={(title, path) =>
						hasDuplicateNoteTitle(notes, selectedNote.id, title, path)
					}
				/>
			) : selectedId ? (
				<div className="grid flex-1 place-items-center">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> Loading note…
					</div>
				</div>
			) : (
				<div className="grid flex-1 place-items-center px-6 text-center">
					<div className="max-w-sm">
						<BookOpenTextIcon className="mx-auto size-10 text-muted-foreground/50" />
						<h1 className="mt-5 font-heading text-2xl font-semibold tracking-tight">
							Choose a note
						</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							Open one from the tree or start a new document.
						</p>
						<Button className="mt-5" onClick={() => void createNote(null)}>
							<FilePlus2Icon /> New note
						</Button>
					</div>
				</div>
			)}

			<Dialog
				open={Boolean(noteDeletion)}
				onOpenChange={(open) => !open && setNoteDeletion(undefined)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete note</DialogTitle>
						<DialogDescription>
							{`“${noteDeletion?.note.title ?? ''}” and its entire version history will be deleted.`}
						</DialogDescription>
					</DialogHeader>
					{noteDeletion?.error && (
						<p className="text-sm text-destructive">{noteDeletion.error}</p>
					)}
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" />}>
							Cancel
						</DialogClose>
						<Button
							variant="destructive"
							onClick={() => void confirmDeleteNote()}
						>
							Delete note
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(folderAction)}
				onOpenChange={(open) => !open && setFolderAction(undefined)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{folderAction?.type === 'rename'
								? 'Rename folder'
								: 'Delete folder'}
						</DialogTitle>
						<DialogDescription>
							{folderAction?.type === 'rename'
								? 'Every note below this path will move with it.'
								: `Delete every note inside ${folderAction?.path ?? 'this folder'} and its history.`}
						</DialogDescription>
					</DialogHeader>
					{folderAction?.type === 'rename' && (
						<label
							htmlFor="folder-destination"
							className="grid gap-2 py-2 text-sm font-medium"
						>
							Destination path
							<Input
								id="folder-destination"
								value={folderAction.value}
								onChange={(event) =>
									setFolderAction({
										...folderAction,
										value: event.target.value,
										error: undefined,
									})
								}
							/>
						</label>
					)}
					{folderAction?.error && (
						<p className="text-sm text-destructive">{folderAction.error}</p>
					)}
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" />}>
							Cancel
						</DialogClose>
						<Button
							variant={
								folderAction?.type === 'delete' ? 'destructive' : 'default'
							}
							onClick={() => void applyFolderAction()}
						>
							{folderAction?.type === 'rename'
								? 'Move folder'
								: 'Delete folder'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
