import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { createReactBlockSpec } from '@blocknote/react';
import { StoredFileView } from '@web/components/notes/note-file-view';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { blockText } from '@web/lib/notes-editor';
import {
	downloadPastedImages,
	uploadNoteFiles,
} from '@web/lib/notes-file-upload';
import {
	STORED_FILE_BLOCK_TYPE,
	type StoredFileState,
} from '@web/lib/notes-files';
import { opensDisplayEquation } from '@web/lib/notes-math';
import type { NotesEditor } from '@web/lib/notes-schema';
import {
	getFile,
	getFileLink,
	publicFileUrl,
	StorageApiError,
	type StoredFile,
	updateFile,
} from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { PaperclipIcon } from 'lucide-react';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from 'react';
import { toast } from 'sonner';

const FILE_MENU_GROUP = 'Files';
/** The slash menu deletes its query but leaves the trigger in the block. */
const FILE_MENU_TRIGGER = '/';

export type NoteFileAccess = {
	/** A URL the browser can load for this file. */
	resolveUrl: (fileId: string) => Promise<string>;
	/** What Storage knows about the file; rejects with a 404 once it is gone. */
	describe: (fileId: string) => Promise<StoredFile>;
	/** Whether the note on screen is published. */
	notePublic: boolean;
	/** A public reader has no session and cannot act on files at all. */
	authenticated: boolean;
};

/**
 * The same schema renders in three places that do not have the same rights: the
 * editor, the read-only history preview, and the public page, where the visitor
 * has no session at all. `editor.isEditable` tells the first from the other two
 * but not the last two from each other, so the context says it outright.
 */
export const editorNoteFileAccess: NoteFileAccess = {
	resolveUrl: (fileId) => getFileLink(fileId, 'inline'),
	describe: (fileId) => getFile(fileId),
	notePublic: false,
	authenticated: true,
};

const NoteFileAccessContext =
	createContext<NoteFileAccess>(editorNoteFileAccess);

export function NoteFileAccessProvider({
	value,
	children,
}: {
	value: NoteFileAccess;
	children: React.ReactNode;
}) {
	return (
		<NoteFileAccessContext.Provider value={value}>
			{children}
		</NoteFileAccessContext.Provider>
	);
}

/** What a public page can offer: a stable URL, and no questions asked. */
export const publicNoteFileAccess: NoteFileAccess = {
	resolveUrl: async (fileId) => publicFileUrl(fileId),
	describe: () => Promise.reject(new StorageApiError(401)),
	notePublic: true,
	authenticated: false,
};

/**
 * Inside a block spec BlockNote narrows the editor's schema to that one block,
 * so its `updateBlock` will not accept a paragraph — the same wall
 * `discardEquationBlock` hits, and answered the same way.
 */
function discardEmptyAttachment(
	editor: { updateBlock: CallableFunction },
	blockId: string,
) {
	editor.updateBlock(blockId, { type: 'paragraph' });
}

function useStoredFile(fileId: string) {
	const access = useContext(NoteFileAccessContext);
	// Depended on individually rather than through `access`: a provider that
	// rebuilds its value every render would otherwise restart this effect on
	// every render, and re-fetch the file forever.
	const { authenticated, describe, resolveUrl } = access;
	const [state, setState] = useState<StoredFileState>('loading');
	const [url, setUrl] = useState<string>();
	const [file, setFile] = useState<StoredFile>();
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry signal, and re-running this is the whole of what it does
	useEffect(() => {
		if (!fileId) {
			setState('empty');
			return;
		}

		let current = true;
		setState('loading');
		setUrl(undefined);

		(async () => {
			// A public reader gets the stable URL and nothing else: asking the
			// private API about the file would 401, and the answer is none of
			// their business anyway.
			if (!authenticated) {
				const link = await resolveUrl(fileId);
				if (!current) return;
				setUrl(link);
				setState('ready');
				return;
			}

			const described = await describe(fileId);
			const link = await resolveUrl(fileId);
			if (!current) return;
			setFile(described);
			setUrl(link);
			setState('ready');
		})().catch((error: unknown) => {
			if (!current) return;
			// Only the server can say a file does not exist. Anything else is a bad
			// moment, and calling it a deletion would tell the user they lost
			// something that is sitting there intact.
			setState(
				error instanceof StorageApiError && error.status === 404
					? 'missing'
					: 'failed',
			);
		});

		return () => {
			current = false;
		};
	}, [attempt, authenticated, describe, fileId, resolveUrl]);

	/**
	 * The bytes would not load. With a session that means the row and the bucket
	 * disagree, which Reconcile exists for; without one it means the file was
	 * never shared, and the reader has no more to learn than that.
	 */
	const reportMediaError = useCallback(
		() =>
			setState((current) =>
				current === 'ready'
					? authenticated
						? 'broken'
						: 'unavailable'
					: current,
			),
		[authenticated],
	);

	return {
		state,
		url,
		file,
		access,
		reportMediaError,
		retry: () => setAttempt((value) => value + 1),
	};
}

export const storedFileBlock = createReactBlockSpec(
	{
		type: STORED_FILE_BLOCK_TYPE,
		// Denormalised on purpose: the block says what it holds before the network
		// answers, and keeps saying it once the file is gone.
		propSchema: {
			fileId: { default: '' },
			name: { default: '' },
			// Not `contentType`: BlockNote renders every prop as a `data-*`
			// attribute, and `data-content-type` is how it marks a block's own
			// type. Naming it that overwrites the marker and the block stops
			// round-tripping through HTML.
			mimeType: { default: '' },
			size: { default: 0 },
			/** Rendered width in pixels; `0` is whatever the media wants to be. */
			width: { default: 0 },
			alignment: { default: 'left', values: ['left', 'center', 'right'] },
			/** A light frame, for a screenshot whose own edges vanish into the page. */
			bordered: { default: false },
		},
		content: 'none',
	},
	{
		render: ({ block, editor }) => {
			const { fileId, name, mimeType, size, width, alignment, bordered } =
				block.props;
			const { state, url, file, access, reportMediaError, retry } =
				useStoredFile(fileId);
			const editable = editor.isEditable;
			// A block inserted from the menu has nothing in it, so it asks straight
			// away rather than sitting there as a button waiting to be found.
			const [picking, setPicking] = useState(editable && !fileId);
			const [previewing, setPreviewing] = useState(false);

			const publish = useCallback(async () => {
				if (!file) return;
				try {
					const updated = await updateFile(file.id, {
						name: file.name,
						path: file.path,
						isPublic: true,
					});
					useStorageStore.getState().upsert([updated]);
					toast.success(`“${updated.name}” is now shared.`);
				} catch {
					toast.error('That file could not be shared.');
				}
			}, [file]);

			const download = useCallback(async () => {
				try {
					window.location.assign(
						access.authenticated
							? await getFileLink(fileId, 'attachment')
							: publicFileUrl(fileId),
					);
				} catch {
					toast.error(`“${name}” could not be downloaded.`);
				}
			}, [access.authenticated, fileId, name]);

			return (
				<>
					<StoredFileView
						state={state}
						width={width}
						alignment={alignment}
						bordered={bordered}
						editable={editable}
						name={file?.name ?? name}
						contentType={file?.contentType ?? mimeType}
						size={file?.size ?? size}
						url={url}
						unshared={
							editable &&
							access.notePublic &&
							file !== undefined &&
							!file.isPublic
						}
						onRetry={retry}
						onPublish={() => void publish()}
						onChoose={() => setPicking(true)}
						onDownload={() => void download()}
						onPreview={file ? () => setPreviewing(true) : undefined}
						onResize={(next) =>
							editor.updateBlock(block, { props: { width: next } })
						}
						onAlign={(next) =>
							editor.updateBlock(block, { props: { alignment: next } })
						}
						onToggleBorder={() =>
							editor.updateBlock(block, { props: { bordered: !bordered } })
						}
						onMediaError={reportMediaError}
					/>
					{previewing && file ? (
						<StoragePreview
							file={file}
							onClose={() => setPreviewing(false)}
							onDownload={() => void download()}
						/>
					) : null}
					{picking && editable ? (
						<NoteFilePickerMount
							onClose={() => {
								setPicking(false);
								// An attachment nobody chose gives back the paragraph it took.
								if (!fileId) discardEmptyAttachment(editor, block.id);
							}}
							onPick={(picked) => {
								setPicking(false);
								editor.updateBlock(block, {
									props: {
										fileId: picked.id,
										name: picked.name,
										mimeType: picked.contentType,
										size: picked.size,
									},
								});
							}}
						/>
					) : null}
				</>
			);
		},
	},
);

/**
 * Loaded only when someone asks for it: the picker drags in the upload machine
 * and the whole file index, and most notes never open one.
 */
function NoteFilePickerMount({
	onClose,
	onPick,
}: {
	onClose: () => void;
	onPick: (file: StoredFile) => void;
}) {
	const [Picker, setPicker] = useState<
		| typeof import('@web/components/notes/note-file-picker').NoteFilePicker
		| null
	>(null);

	useEffect(() => {
		let current = true;
		void import('@web/components/notes/note-file-picker').then((module) => {
			if (current) setPicker(() => module.NoteFilePicker);
		});
		return () => {
			current = false;
		};
	}, []);

	if (!Picker) return null;
	return <Picker onClose={onClose} onPick={onPick} />;
}

type FileMenuEditor = Pick<
	NotesEditor,
	| 'getTextCursorPosition'
	| 'insertBlocks'
	| 'setTextCursorPosition'
	| 'updateBlock'
>;

/**
 * Turns files that arrived by paste or drop into blocks, once storage has them.
 *
 * The upload happens before anything is inserted: a block exists to point at a
 * file, and there is nothing to point at until the server says so.
 */
/**
 * Imports images that were pasted as markup rather than as files, and reports
 * what could not be read. A cross-origin image the browser refuses to fetch is
 * said out loud instead of being left as a link into somebody else's server.
 */
export async function attachPastedImages(
	editor: FileMenuEditor,
	sources: string[],
) {
	const { files, failed } = await downloadPastedImages(sources);
	const stored = files.length > 0 ? await attachFilesToNote(editor, files) : [];
	return { attached: stored.length, failed: failed.length };
}

export async function attachFilesToNote(
	editor: FileMenuEditor,
	selected: File[],
) {
	const stored = await uploadNoteFiles(selected);
	if (stored.length === 0) throw new Error('Nothing was stored');

	const blocks = stored.map(
		(file) =>
			({
				type: STORED_FILE_BLOCK_TYPE,
				props: {
					fileId: file.id,
					name: file.name,
					mimeType: file.contentType,
					size: file.size,
				},
			}) as const,
	);
	const { block } = editor.getTextCursorPosition();
	const [first, ...rest] = blocks;

	// Pasting into an empty paragraph takes it over, rather than leaving a blank
	// line above the file the user just pasted.
	if (first && blockText(block).trim() === '') {
		editor.updateBlock(block, first);
		if (rest.length > 0) editor.insertBlocks(rest, block, 'after');
	} else {
		editor.insertBlocks(blocks, block, 'after');
	}
	return stored;
}

export function fileSlashMenuItems(
	editor: FileMenuEditor,
): DefaultReactSuggestionItem[] {
	return [
		{
			title: 'File',
			subtext: 'Attach an image, video or document',
			group: FILE_MENU_GROUP,
			icon: <PaperclipIcon />,
			onItemClick: () => {
				const { block } = editor.getTextCursorPosition();
				const attachment = {
					type: STORED_FILE_BLOCK_TYPE,
					props: { fileId: '', name: '', mimeType: '', size: 0, width: 0 },
				} as const;
				// Like a display equation, an attachment replaces the block it lands
				// on, so picking one from the middle of a written line adds it below
				// instead of erasing the line.
				if (opensDisplayEquation(blockText(block), FILE_MENU_TRIGGER)) {
					editor.updateBlock(block, attachment);
					return;
				}
				const [inserted] = editor.insertBlocks([attachment], block, 'after');
				if (inserted) editor.setTextCursorPosition(inserted);
			},
		},
	];
}
