import { filterSuggestionItems } from '@blocknote/core/extensions';
import {
	getDefaultReactSlashMenuItems,
	SuggestionMenuController,
	useCreateBlockNote,
	useEditorState,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { NoteFind } from '@web/components/notes/note-find';
import { NoteHistory } from '@web/components/notes/note-history';
import { mathSlashMenuItems } from '@web/components/notes/note-math';
import { Button } from '@web/components/ui/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Spinner } from '@web/components/ui/spinner';
import { usePwaAvailability } from '@web/lib/availability';
import {
	isDeleteBlockShortcut,
	isNoteFindShortcut,
	isNoteReplaceShortcut,
	isNoteSaveShortcut,
} from '@web/lib/notes';
import {
	enqueueNoteSave,
	type LocalNote,
	notesDb,
	updateNoteContentDraft,
} from '@web/lib/notes-db';
import {
	centerCurrentFindResult,
	copyCurrentBlock,
	cutCurrentBlock,
	deleteCurrentBlock,
	NoteFindExtension,
	NoteMathExtension,
	type NoteSyncState,
	normalizePath,
	noteCompactStatusLabel,
	noteStatusLabel,
	pasteCopiedBlock,
	unavailableSlashItems,
} from '@web/lib/notes-editor';
import type { NotesPreferences } from '@web/lib/notes-preferences';
import { type NoteBlock, notesSchema } from '@web/lib/notes-schema';
import { syncNoteOutbox, updateAndSyncNoteMetadata } from '@web/lib/notes-sync';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	CloudIcon,
	CloudOffIcon,
	FileTextIcon,
	FolderIcon,
	HistoryIcon,
	RefreshCwIcon,
	SaveIcon,
	SearchIcon,
	Trash2Icon,
} from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

const serverVersionFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
	timeStyle: 'medium',
});
const serverTimeFormat = new Intl.DateTimeFormat(undefined, {
	timeStyle: 'short',
});

export function NoteDocument({
	note,
	preferences,
	focusTitle,
	treeOpen,
	refreshing,
	onRefresh,
	onTitleFocused,
	onRequestDelete,
	isTitleTaken,
}: {
	note: LocalNote;
	preferences: NotesPreferences;
	focusTitle: boolean;
	treeOpen: boolean;
	refreshing: boolean;
	onRefresh: () => void;
	onTitleFocused: () => void;
	onRequestDelete: () => void;
	/** The tree enforces the same rule; the header must not be a way around it. */
	isTitleTaken: (title: string, path: string | null) => boolean;
}) {
	const editor = useCreateBlockNote({
		initialContent: note.content,
		extensions: [NoteFindExtension, NoteMathExtension],
		schema: notesSchema,
	});
	const [title, setTitle] = useState(note.title);
	const [path, setPath] = useState(note.path ?? '');
	const [historyOpen, setHistoryOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [syncError, setSyncError] = useState(false);
	const [titleError, setTitleError] = useState('');
	const [findOpen, setFindOpen] = useState(false);
	const [findMode, setFindMode] = useState<'find' | 'replace'>('find');
	const [findFocusRequest, setFindFocusRequest] = useState(0);
	const findState = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => {
			const storage = currentEditor._tiptapEditor.storage.findAndReplace;
			return {
				query: storage.searchTerm,
				replacement: storage.replaceTerm,
				resultCount: storage.results.length,
				currentIndex: storage.currentIndex,
			};
		},
	});
	const draftRef = useRef<NoteBlock[]>(editor.document as NoteBlock[]);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const editorViewportRef = useRef<HTMLDivElement>(null);
	const focusTitleOnMount = useRef(focusTitle);
	const titleRef = useRef(title);
	const pathRef = useRef(path);
	const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftChanged = useRef(false);
	const metadataChanged = useRef(false);
	const applyingRemote = useRef(false);
	const loadedContent = useRef(JSON.stringify(note.content));
	const availability = usePwaAvailability();
	const isOnline = availability === 'online';
	const pendingCount = useLiveQuery(
		() => notesDb.outbox.where('noteId').equals(note.id).count(),
		[note.id],
		0,
	);

	titleRef.current = title;
	pathRef.current = path;
	const notifyTitleFocused = useEffectEvent(onTitleFocused);

	useEffect(() => {
		if (focusTitleOnMount.current) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
			notifyTitleFocused();
			return;
		}
		// A touch keyboard would cover the note the moment it opens, so the editor
		// only takes focus where typing does not shrink the viewport.
		if (window.matchMedia('(pointer: fine)').matches) editor.focus();
	}, [editor]);

	useEffect(() => {
		if (
			pendingCount > 0 ||
			draftChanged.current ||
			metadataChanged.current ||
			!note.content
		)
			return;

		const content = JSON.stringify(note.content);
		const contentChanged = content !== loadedContent.current;
		const metadataDiffers =
			note.title !== titleRef.current || (note.path ?? '') !== pathRef.current;
		if (!contentChanged && !metadataDiffers) return;

		applyingRemote.current = true;
		if (contentChanged) editor.replaceBlocks(editor.document, note.content);
		loadedContent.current = content;
		draftRef.current = note.content;
		titleRef.current = note.title;
		pathRef.current = note.path ?? '';
		setTitle(note.title);
		setPath(note.path ?? '');
		queueMicrotask(() => {
			applyingRemote.current = false;
		});
	}, [editor, note.content, note.path, note.title, pendingCount]);

	const persistDraft = useEffectEvent(async () => {
		const next = JSON.stringify(draftRef.current);
		// Also guards the remote-apply path: a change event that slips past
		// `applyingRemote` cannot turn an accepted snapshot back into a draft.
		if (next === loadedContent.current) {
			draftChanged.current = false;
			return;
		}
		const wasChanged = draftChanged.current;
		const previousContent = loadedContent.current;
		draftChanged.current = false;
		loadedContent.current = next;
		try {
			await updateNoteContentDraft(notesDb, note.id, draftRef.current);
		} catch (error) {
			draftChanged.current = wasChanged;
			loadedContent.current = previousContent;
			throw error;
		}
	});

	const persistMetadata = useEffectEvent(async () => {
		if (!metadataChanged.current) return;
		const nextTitle = titleRef.current.trim() || 'Untitled';
		const nextPath = normalizePath(pathRef.current);
		if (isTitleTaken(nextTitle, nextPath)) {
			setTitleError('A note with this title already exists in this folder.');
			return;
		}
		metadataChanged.current = false;
		setTitleError('');
		const synced = await updateAndSyncNoteMetadata(note.id, {
			title: nextTitle,
			path: nextPath,
		});
		if (isOnline && !synced) setSyncError(true);
	});

	const scheduleDraft = () => {
		draftChanged.current = true;
		if (draftTimer.current) clearTimeout(draftTimer.current);
		draftTimer.current = setTimeout(() => void persistDraft(), 250);
	};
	const scheduleMetadata = () => {
		metadataChanged.current = true;
		if (metadataTimer.current) clearTimeout(metadataTimer.current);
		metadataTimer.current = setTimeout(
			() => void persistMetadata().catch(() => undefined),
			250,
		);
	};

	useEffect(() => {
		return () => {
			if (draftTimer.current) clearTimeout(draftTimer.current);
			if (metadataTimer.current) clearTimeout(metadataTimer.current);
			if (draftChanged.current) void persistDraft();
			if (metadataChanged.current)
				void persistMetadata().catch(() => undefined);
		};
	}, []);

	const save = useEffectEvent(async () => {
		if (saving) return;
		if (draftTimer.current) clearTimeout(draftTimer.current);
		if (metadataTimer.current) clearTimeout(metadataTimer.current);
		// Saving an unchanged, already-synced note would append a version identical
		// to the current one, so only metadata is flushed in that case.
		const hasLocalWork =
			note.dirty || draftChanged.current || metadataChanged.current;
		const neverSynced = note.serverUpdatedAt === undefined;
		setSaving(true);
		setSyncError(false);
		try {
			await persistMetadata();
			await persistDraft();
			if (hasLocalWork || neverSynced) {
				const operation = await enqueueNoteSave(notesDb, note.id);
				loadedContent.current = JSON.stringify(operation.content);
			}
			if (isOnline) await syncNoteOutbox();
		} catch {
			setSyncError(true);
		} finally {
			setSaving(false);
		}
	});
	const openFind = (mode: 'find' | 'replace') => {
		setFindMode(mode);
		setFindOpen(true);
		setFindFocusRequest((request) => request + 1);
	};
	const closeFind = () => {
		editor._tiptapEditor.commands.clearSearch();
		editor._tiptapEditor.commands.setReplaceTerm('');
		setFindOpen(false);
		requestAnimationFrame(() => editor.focus());
	};
	const goToFindResult = (direction: 'next' | 'previous') => {
		if (direction === 'next') editor._tiptapEditor.commands.goToNextResult();
		else editor._tiptapEditor.commands.goToPreviousResult();
		if (editorViewportRef.current)
			centerCurrentFindResult(editorViewportRef.current);
	};
	const openFindFromShortcut = useEffectEvent(openFind);
	const closeFindFromShortcut = useEffectEvent(closeFind);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// History and the delete confirmation are modal: while one owns focus it
			// also owns these keys, or Escape would close find and leave the dialog
			// open behind it.
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest('[role="dialog"], [role="alertdialog"]')
			)
				return;

			if (findOpen && event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				closeFindFromShortcut();
			} else if (isNoteSaveShortcut(event)) {
				event.preventDefault();
				void save();
			} else if (isNoteFindShortcut(event)) {
				event.preventDefault();
				openFindFromShortcut('find');
			} else if (isNoteReplaceShortcut(event)) {
				event.preventDefault();
				openFindFromShortcut('replace');
			}
		};
		document.addEventListener('keydown', handleKeyDown, true);
		return () => document.removeEventListener('keydown', handleKeyDown, true);
	}, [findOpen]);

	const restore = async (content: NoteBlock[]) => {
		editor.replaceBlocks(editor.document, content);
		draftRef.current = editor.document as NoteBlock[];
		draftChanged.current = true;
		await save();
	};
	const hasTextSelection = () => window.getSelection()?.isCollapsed === false;

	const syncState: NoteSyncState = saving
		? 'saving'
		: note.syncFailure
			? 'rejected'
			: syncError
				? 'failed'
				: pendingCount > 0
					? isOnline
						? 'pending'
						: 'offline'
					: note.dirty
						? 'draft'
						: 'synced';
	const statusLabel = noteStatusLabel(syncState, note.syncFailure);
	const compactStatusLabel = noteCompactStatusLabel(syncState);
	const blocked = syncState === 'rejected' || syncState === 'failed';
	const serverVersionLabel = note.serverUpdatedAt
		? serverVersionFormat.format(note.serverUpdatedAt)
		: 'Not synced yet';
	const serverVersionTimeLabel = note.serverUpdatedAt
		? serverTimeFormat.format(note.serverUpdatedAt)
		: 'Not synced';
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			<div
				className={`flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-background py-2 pr-3 sm:h-14 sm:flex-nowrap sm:py-0 sm:pr-5 ${treeOpen ? 'pl-3 sm:pl-5' : 'pl-14'}`}
			>
				<div className="order-first flex w-full min-w-0 items-center gap-1 sm:w-auto sm:flex-none">
					<InputGroup className="h-8 w-[min(8rem,34vw)] shrink-0 bg-input/20 sm:w-fit">
						<InputGroupAddon className="pl-2">
							<FolderIcon />
						</InputGroupAddon>
						<InputGroupInput
							size={1}
							value={path}
							onChange={(event) => {
								setPath(event.target.value);
								scheduleMetadata();
							}}
							aria-label="Folder path"
							placeholder="Root"
							className="pr-3 pl-1 text-xs text-muted-foreground sm:w-auto sm:min-w-12 sm:max-w-48 sm:flex-none sm:field-sizing-content"
						/>
					</InputGroup>
					<InputGroup className="h-8 min-w-24 flex-1 bg-input/20 sm:w-fit sm:flex-none">
						<InputGroupAddon className="pl-2">
							<FileTextIcon />
						</InputGroupAddon>
						<InputGroupInput
							size={1}
							ref={titleInputRef}
							value={title}
							onChange={(event) => {
								setTitle(event.target.value);
								scheduleMetadata();
							}}
							aria-label="Note title"
							aria-invalid={Boolean(titleError)}
							title={titleError || undefined}
							className="pr-3 pl-1 font-heading text-sm font-semibold sm:w-auto sm:min-w-20 sm:max-w-96 sm:flex-none sm:field-sizing-content"
						/>
					</InputGroup>
					<span className="sr-only" aria-live="polite">
						{titleError}
					</span>
				</div>
				<div
					className="flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground sm:ml-auto"
					aria-live="polite"
				>
					{pendingCount > 0 || blocked ? (
						<CloudOffIcon className="size-3.5" />
					) : (
						<CloudIcon className="size-3.5" />
					)}
					<div className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[0.65rem] sm:hidden">
						<span
							className={`truncate text-xs ${blocked ? 'text-destructive' : ''}`}
						>
							{compactStatusLabel}
						</span>
						<span aria-hidden="true">·</span>
						<span className="truncate">{serverVersionTimeLabel}</span>
					</div>
					<div className="hidden min-w-0 max-w-28 leading-tight sm:block">
						<p
							className="truncate text-[0.65rem]"
							title={`Latest server content version: ${serverVersionLabel}`}
						>
							{serverVersionLabel}
						</p>
						<p
							className={`truncate text-xs ${blocked ? 'text-destructive' : ''}`}
							title={statusLabel}
						>
							{statusLabel}
						</p>
					</div>
					<span className="sr-only">
						{serverVersionLabel}. {statusLabel}
					</span>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0">
					<Button
						size="icon-sm"
						variant="ghost"
						className="sm:hidden"
						onClick={() => openFind('find')}
						aria-label="Find in note"
						aria-keyshortcuts="Control+F"
					>
						<SearchIcon />
					</Button>
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
						size="sm"
						variant="ghost"
						onClick={() => setHistoryOpen(true)}
					>
						<HistoryIcon /> <span className="hidden sm:inline">History</span>
					</Button>
					<Button
						size="sm"
						onClick={() => void save()}
						disabled={saving}
						aria-keyshortcuts="Control+S"
					>
						{saving ? <Spinner /> : <SaveIcon />}
						<span className="hidden sm:inline">Save</span>
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						onClick={onRequestDelete}
						aria-label="Delete note"
					>
						<Trash2Icon />
					</Button>
				</div>
			</div>
			<div className="relative min-h-0 flex-1">
				{findOpen && (
					<NoteFind
						mode={findMode}
						query={findState.query}
						replacement={findState.replacement}
						resultCount={findState.resultCount}
						currentIndex={findState.currentIndex}
						focusRequest={findFocusRequest}
						onModeChange={setFindMode}
						onQueryChange={(query) =>
							editor._tiptapEditor.commands.setSearchTerm(query)
						}
						onReplacementChange={(replacement) =>
							editor._tiptapEditor.commands.setReplaceTerm(replacement)
						}
						onNext={() => goToFindResult('next')}
						onPrevious={() => goToFindResult('previous')}
						onReplace={() => editor._tiptapEditor.commands.replace()}
						onReplaceAll={() => editor._tiptapEditor.commands.replaceAll()}
						onClose={closeFind}
					/>
				)}
				<div
					ref={editorViewportRef}
					className="notes-editor h-full overflow-y-auto overscroll-contain"
					data-font-size={preferences.fontSize}
					data-margins={preferences.margins}
					onKeyDownCapture={(event) => {
						if (!isDeleteBlockShortcut(event)) return;
						event.preventDefault();
						deleteCurrentBlock(editor);
					}}
					onCopyCapture={(event) => {
						if (
							!copyCurrentBlock(editor, event.clipboardData, hasTextSelection())
						)
							return;
						event.preventDefault();
					}}
					onCutCapture={(event) => {
						if (
							!cutCurrentBlock(editor, event.clipboardData, hasTextSelection())
						)
							return;
						event.preventDefault();
					}}
					onPasteCapture={(event) => {
						if (!pasteCopiedBlock(editor, event.clipboardData)) return;
						event.preventDefault();
					}}
				>
					<BlockNoteView
						editor={editor}
						theme="dark"
						formattingToolbar={!findOpen}
						slashMenu={false}
						onChange={() => {
							draftRef.current = editor.document as NoteBlock[];
							if (applyingRemote.current) return;
							scheduleDraft();
						}}
					>
						<SuggestionMenuController
							triggerCharacter="/"
							getItems={async (query) =>
								filterSuggestionItems(
									[
										...getDefaultReactSlashMenuItems(editor).filter(
											(item) => !unavailableSlashItems.has(item.title),
										),
										...mathSlashMenuItems(editor),
									],
									query,
								)
							}
						/>
					</BlockNoteView>
				</div>
			</div>
			<NoteHistory
				noteId={note.id}
				preferences={preferences}
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				onRestore={restore}
				getCurrentContent={() => draftRef.current}
			/>
		</div>
	);
}
