import {
	canDropFolder,
	type FileMoveResult,
	isDuplicateName,
	joinPath,
} from '@web/lib/storage';
import {
	deleteFile,
	deleteFiles,
	deleteFolder,
	getFileLink,
	listFiles,
	moveFiles,
	reconcileStorage,
	renameFolder,
	StorageApiError,
	type StoredFile,
	storageTransport,
	updateFile,
} from '@web/lib/storage-api';
import {
	createUploadQueue,
	type UploadCandidate,
	type UploadItem,
} from '@web/lib/storage-upload';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/** A rejection the server will keep rejecting, told apart from a bad moment. */
function isConflict(error: unknown) {
	return error instanceof StorageApiError && error.status === 409;
}

/**
 * The server index and every operation on it.
 *
 * Storage is not local-first: there is no Dexie, no outbox and no last-write-
 * wins. The API is the source, this holds the copy on screen, and the route it
 * serves is left with view state, dialogs and layout.
 */
export function useStorageFiles({
	path,
	selectedIds,
	onSelectionMoved,
}: {
	/** The open folder, which is where uploads and folder operations land. */
	path: string | null;
	selectedIds: Set<string>;
	/** Called when a move consumed the whole selection, so it can be dropped. */
	onSelectionMoved: () => void;
}) {
	const [files, setFiles] = useState<StoredFile[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [reconciling, setReconciling] = useState(false);
	const [loadError, setLoadError] = useState<string>();
	const [uploads, setUploads] = useState<UploadItem[]>([]);

	const reload = useCallback(async (background = false) => {
		if (background) setRefreshing(true);
		try {
			setFiles(await listFiles());
			setLoadError(undefined);
		} catch {
			setLoadError(
				navigator.onLine
					? 'Your files could not be loaded. Try again in a moment.'
					: 'No connection. Storage needs to reach the server.',
			);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const queue = useMemo(
		() =>
			createUploadQueue({ transport: storageTransport, onChange: setUploads }),
		[],
	);

	const upload = useCallback(
		async (selected: File[]) => {
			const candidates: UploadCandidate[] = selected.flatMap((item) => {
				if (isDuplicateName(files, path, item.name)) {
					toast.error(`“${item.name}” already exists in this folder.`);
					return [];
				}
				return [
					{
						id: crypto.randomUUID(),
						name: item.name,
						path,
						contentType: item.type || 'application/octet-stream',
						size: item.size,
						body: item,
					},
				];
			});
			if (candidates.length === 0) return;

			await queue.enqueue(candidates);
			const candidateIds = new Set(candidates.map((item) => item.id));
			const completed = queue
				.items()
				.filter(
					(item) => candidateIds.has(item.id) && item.status === 'completed',
				).length;
			await reload(true);
			queue.clearSettled();
			if (completed > 0)
				toast.success(
					`${completed} ${completed === 1 ? 'file' : 'files'} uploaded.`,
				);
		},
		[files, path, queue, reload],
	);

	const download = useCallback(async (file: StoredFile) => {
		try {
			window.location.assign(await getFileLink(file.id, 'attachment'));
		} catch {
			toast.error(`“${file.name}” could not be downloaded.`);
		}
	}, []);

	const setPublic = useCallback(async (file: StoredFile, isPublic: boolean) => {
		const updated = await updateFile(file.id, {
			name: file.name,
			path: file.path,
			isPublic,
		});
		setFiles((current) =>
			current.map((item) => (item.id === updated.id ? updated : item)),
		);
		return updated;
	}, []);

	const moveMany = useCallback(
		async (
			targets: StoredFile[],
			destination: string | null,
		): Promise<FileMoveResult> => {
			if (targets.every((file) => file.path === destination)) return 'same';
			// Only a move of the whole selection ends the selection. Dragging one
			// unrelated file away is no reason to throw the rest of it out.
			const movedTheSelection =
				selectedIds.size > 0 &&
				targets.every((file) => selectedIds.has(file.id));
			const movingIds = new Set(targets.map((file) => file.id));
			if (
				targets.some((target) =>
					isDuplicateName(
						files.filter((file) => !movingIds.has(file.id)),
						destination,
						target.name,
					),
				)
			)
				return 'conflict';

			try {
				const moved = await moveFiles(
					targets.map((file) => file.id),
					destination,
				);
				const byId = new Map(moved.map((file) => [file.id, file]));
				setFiles((current) => current.map((file) => byId.get(file.id) ?? file));
				if (movedTheSelection) onSelectionMoved();
				return 'moved';
			} catch (error) {
				return isConflict(error) ? 'conflict' : 'failed';
			}
		},
		[files, onSelectionMoved, selectedIds],
	);

	/** Moving a folder is a prefix rename: storage never sees it at all. */
	const moveFolder = useCallback(
		async (
			name: string,
			destination: string | null,
		): Promise<FileMoveResult> => {
			const from = joinPath(path, name);
			if (!canDropFolder(from, destination)) return 'same';
			try {
				await renameFolder(from, joinPath(destination, name));
				await reload(true);
				return 'moved';
			} catch (error) {
				return isConflict(error) ? 'conflict' : 'failed';
			}
		},
		[path, reload],
	);

	const renameFile = useCallback(
		async (file: StoredFile, name: string) => {
			if (isDuplicateName(files, file.path, name, file.id))
				return 'A file with this name already exists in that folder.';
			try {
				const updated = await updateFile(file.id, {
					name,
					path: file.path,
					isPublic: file.isPublic,
				});
				setFiles((current) =>
					current.map((item) => (item.id === updated.id ? updated : item)),
				);
				return undefined;
			} catch (error) {
				if (isConflict(error))
					return 'A file with this name already exists in that folder.';
				return navigator.onLine
					? 'The server rejected this name.'
					: 'Renaming requires a connection.';
			}
		},
		[files],
	);

	const renameFolderTo = useCallback(
		async (name: string, next: string) => {
			try {
				await renameFolder(joinPath(path, name), joinPath(path, next));
				await reload(true);
				return undefined;
			} catch (error) {
				if (isConflict(error))
					return 'That folder already holds a file with the same name.';
				return navigator.onLine
					? 'The server rejected this name.'
					: 'Renaming requires a connection.';
			}
		},
		[path, reload],
	);

	const removeFile = useCallback(async (id: string) => {
		await deleteFile(id);
		setFiles((current) => current.filter((file) => file.id !== id));
	}, []);

	const removeFiles = useCallback(async (ids: string[]) => {
		const result = await deleteFiles(ids);
		const deleted = new Set(result.deleted);
		setFiles((current) => current.filter((file) => !deleted.has(file.id)));
		return result;
	}, []);

	const removeFolder = useCallback(
		async (name: string) => {
			const result = await deleteFolder(joinPath(path, name));
			if (result.failed.length > 0)
				throw new Error('Some objects could not be deleted');
			await reload(true);
		},
		[path, reload],
	);

	const reconcile = useCallback(async () => {
		setReconciling(true);
		try {
			const report = await reconcileStorage();
			const fixed =
				report.deletedObjects.length +
				report.deletedRows.length +
				report.abortedUploads.length;
			await reload(true);
			toast.success(
				fixed === 0
					? 'Storage and the database already agree.'
					: `Reconciled ${fixed} inconsistenc${fixed === 1 ? 'y' : 'ies'}.`,
			);
			return true;
		} catch {
			toast.error('Storage could not be reconciled.');
			return false;
		} finally {
			setReconciling(false);
		}
	}, [reload]);

	return {
		files,
		loading,
		refreshing,
		reconciling,
		loadError,
		uploads,
		reload,
		upload,
		cancelUpload: queue.cancel,
		dismissUpload: queue.remove,
		download,
		setPublic,
		moveMany,
		moveFolder,
		renameFile,
		renameFolder: renameFolderTo,
		removeFile,
		removeFiles,
		removeFolder,
		reconcile,
	};
}
