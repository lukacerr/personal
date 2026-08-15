import {
	StorageBulkDownloadDialog,
	StorageDeleteDialog,
	type StorageDeleteTarget,
	StorageReconcileDialog,
} from '@web/components/storage/storage-dialogs';
import { StorageList } from '@web/components/storage/storage-list';
import {
	StorageMove,
	type StorageMoveTarget,
} from '@web/components/storage/storage-move';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { StorageSelection } from '@web/components/storage/storage-selection';
import { StorageShare } from '@web/components/storage/storage-share';
import { StorageToolbar } from '@web/components/storage/storage-toolbar';
import { StorageUploads } from '@web/components/storage/storage-upload';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import {
	buildStorageTree,
	collectFileTypes,
	collectFolderPaths,
	filterStorageFiles,
	hasStorageFilters,
	joinPath,
	needsUnreferencedFiles,
	parseStorageView,
	reconcileStorageSelection,
	sortStorageFiles,
	storageSelectionKey,
	storageSummary,
	updateStorageSearchParams,
	validateFileName,
	validateFolderName,
} from '@web/lib/storage';
import { listUnreferencedFiles, type StoredFile } from '@web/lib/storage-api';
import {
	BulkDownloadError,
	downloadStorageZip,
} from '@web/lib/storage-bulk-download';
import { useStorageFiles } from '@web/lib/storage-files';
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

export function meta() {
	return [{ title: 'Storage · Personal' }];
}

export default function Storage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const view = parseStorageView(searchParams);
	const [queryInput, setQueryInput] = useState(view.query);
	const deferredQuery = useDeferredValue(queryInput);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [sharing, setSharing] = useState<StoredFile>();
	const [moving, setMoving] = useState<StorageMoveTarget>();
	const [deleting, setDeleting] = useState<StorageDeleteTarget>();
	const [deleteError, setDeleteError] = useState<string>();
	const [dialogBusy, setDialogBusy] = useState(false);
	const [confirmReconcile, setConfirmReconcile] = useState(false);
	const [draggingUpload, setDraggingUpload] = useState(false);
	const [bulkDownloadOpen, setBulkDownloadOpen] = useState(false);
	const [bulkDownloadProgress, setBulkDownloadProgress] = useState(0);
	const [bulkDownloadError, setBulkDownloadError] = useState<string>();
	const bulkDownloadController = useRef<AbortController | undefined>(undefined);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const selectionViewKey = storageSelectionKey(view, queryInput);
	const previousSelectionView = useRef(selectionViewKey);

	const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

	const storage = useStorageFiles({
		path: view.path,
		selectedIds,
		onSelectionMoved: clearSelection,
	});
	const { files } = storage;

	// A maintenance view rather than a folder: the set comes from the server and
	// says which Notes uploads no note references anymore.
	const unusedMode = needsUnreferencedFiles(view);
	const [unused, setUnused] = useState<StoredFile[]>([]);
	const [unusedLoading, setUnusedLoading] = useState(false);
	const reloadUnused = useCallback(async () => {
		setUnusedLoading(true);
		try {
			setUnused(await listUnreferencedFiles());
		} catch {
			toast.error('The unused files could not be listed.');
		} finally {
			setUnusedLoading(false);
		}
	}, []);

	useEffect(() => {
		if (unusedMode) void reloadUnused();
	}, [reloadUnused, unusedMode]);

	const indexFiles = unusedMode ? unused : files;

	// A refresh can retire files the selection still names.
	useEffect(() => {
		setSelectedIds((current) => reconcileStorageSelection(current, files));
	}, [files]);

	useEffect(() => {
		setQueryInput(view.query);
	}, [view.query]);

	useEffect(() => {
		if (queryInput === view.query) return;
		const timeout = window.setTimeout(() => {
			setSearchParams(
				(current) => updateStorageSearchParams(current, { query: queryInput }),
				{ replace: true },
			);
		}, 150);
		return () => window.clearTimeout(timeout);
	}, [queryInput, setSearchParams, view.query]);

	useEffect(() => {
		if (previousSelectionView.current === selectionViewKey) return;
		previousSelectionView.current = selectionViewKey;
		clearSelection();
	}, [clearSelection, selectionViewKey]);

	const activeView = { ...view, query: queryInput };
	const resultMode = hasStorageFilters(activeView);
	const baseTree = useMemo(
		() => buildStorageTree(indexFiles, view.path),
		[indexFiles, view.path],
	);
	const visibleFiles = useMemo(() => {
		const candidates = resultMode
			? filterStorageFiles(
					indexFiles,
					// The unused view is about the whole bucket, not the open folder:
					// these files live wherever Notes put them.
					unusedMode ? null : view.path,
					{
						query: deferredQuery,
						types: view.types,
						visibility: view.visibility,
						uploaded: view.uploaded,
						source: view.source,
					},
				)
			: baseTree.files;
		return sortStorageFiles(candidates, view.sort);
	}, [
		baseTree.files,
		deferredQuery,
		indexFiles,
		resultMode,
		unusedMode,
		view.path,
		view.sort,
		view.source,
		view.types,
		view.uploaded,
		view.visibility,
	]);
	const visibleFolders = resultMode ? [] : baseTree.folders;
	const summary = storageSummary(visibleFiles);
	const types = useMemo(() => collectFileTypes(indexFiles), [indexFiles]);
	const preview = indexFiles.find((file) => file.id === view.file);
	const folderPaths = useMemo(() => collectFolderPaths(files), [files]);
	const selectedFiles = files.filter((file) => selectedIds.has(file.id));

	const setView = useCallback(
		(patch: Parameters<typeof updateStorageSearchParams>[1], replace = true) =>
			setSearchParams((current) => updateStorageSearchParams(current, patch), {
				replace,
			}),
		[setSearchParams],
	);
	const openFolder = (path: string | null) => setView({ path }, false);

	const togglePublic = async (file: StoredFile, isPublic: boolean) => {
		const updated = await storage.setPublic(file, isPublic);
		setSharing((current) => (current?.id === updated.id ? updated : current));
	};

	const moveFromDialog = async (path: string | null) => {
		if (!moving) return 'That is no longer available.';
		const result =
			moving.kind === 'folder'
				? await storage.moveFolder(moving.name, path)
				: await storage.moveMany(moving.files, path);

		if (result === 'conflict')
			return 'A file with this name already exists in that folder.';
		if (result === 'failed')
			return navigator.onLine
				? 'The server rejected this move.'
				: 'Moving requires a connection.';
		if (result === 'same') return 'That is already where it is.';

		const label =
			moving.kind === 'folder'
				? `folder “${moving.name}”`
				: moving.files.length === 1
					? `“${moving.files[0]?.name}”`
					: `${moving.files.length} files`;
		toast.success(`Moved ${label} to ${path ?? 'Root'}.`);
		return undefined;
	};

	const renameFileInline = async (file: StoredFile, value: string) => {
		const name = value.trim();
		return validateFileName(name) ?? storage.renameFile(file, name);
	};

	const renameFolderInline = async (name: string, value: string) => {
		const next = value.trim();
		return validateFolderName(next) ?? storage.renameFolder(name, next);
	};

	const confirmDelete = async () => {
		if (!deleting || dialogBusy) return;
		setDialogBusy(true);
		setDeleteError(undefined);
		try {
			if (deleting.kind === 'bulk') {
				const result = await storage.removeFiles(
					deleting.files.map((file) => file.id),
				);
				// Whatever failed stays selected, so retrying is one click away.
				setSelectedIds(new Set(result.failed.map((failure) => failure.id)));
				const gone = new Set(result.deleted);
				setUnused((current) => current.filter((file) => !gone.has(file.id)));
				if (result.failed.length > 0) {
					setDeleteError(
						`${result.deleted.length} deleted; ${result.failed.length} failed. Retry the remaining files.`,
					);
					return;
				}
			} else if (deleting.kind === 'file') {
				await storage.removeFile(deleting.file.id);
				setUnused((current) =>
					current.filter((file) => file.id !== deleting.file.id),
				);
			} else {
				await storage.removeFolder(deleting.name);
			}
			setDeleting(undefined);
		} catch {
			setDeleteError(
				navigator.onLine
					? 'The server rejected this deletion.'
					: 'Deleting requires a connection.',
			);
		} finally {
			setDialogBusy(false);
		}
	};

	const startBulkDownload = async () => {
		const controller = new AbortController();
		bulkDownloadController.current = controller;
		setBulkDownloadOpen(true);
		setBulkDownloadProgress(0);
		setBulkDownloadError(undefined);
		try {
			await downloadStorageZip(
				selectedFiles,
				view.path,
				setBulkDownloadProgress,
				controller.signal,
			);
			setBulkDownloadOpen(false);
			clearSelection();
		} catch (error) {
			if (error instanceof BulkDownloadError && error.code === 'CANCELLED') {
				setBulkDownloadOpen(false);
				return;
			}
			setBulkDownloadError(
				error instanceof BulkDownloadError && error.code === 'TOO_LARGE'
					? 'This browser cannot build ZIPs over 100 MB in memory. Use desktop Chrome or select fewer files.'
					: 'The ZIP could not be downloaded. Try again.',
			);
		} finally {
			bulkDownloadController.current = undefined;
		}
	};

	const cancelBulkDownload = () => {
		bulkDownloadController.current?.abort();
		setBulkDownloadOpen(false);
	};

	const toggleSelected = (id: string) => {
		if (!selectedIds.has(id) && selectedIds.size >= 500) {
			toast.error('Bulk actions support up to 500 files at once.');
			return;
		}
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const selectAll = () => {
		if (visibleFiles.length > 500) {
			toast.error('Bulk actions support up to 500 files at once.');
			return;
		}
		setSelectedIds((current) =>
			visibleFiles.every((file) => current.has(file.id))
				? new Set()
				: new Set(visibleFiles.map((file) => file.id)),
		);
	};

	return (
		<section
			aria-label="Files"
			className="relative flex min-h-0 flex-1 flex-col"
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes('Files')) {
					event.preventDefault();
					setDraggingUpload(true);
				}
			}}
			onDragLeave={(event) => {
				// `relatedTarget` is whatever the pointer entered. Comparing targets
				// instead leaves the overlay stuck whenever the drag exits over a
				// child, which is nearly always.
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					setDraggingUpload(false);
			}}
			onDrop={(event) => {
				if (!event.dataTransfer.files.length) return;
				event.preventDefault();
				setDraggingUpload(false);
				void storage.upload([...event.dataTransfer.files]);
			}}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
				<StorageToolbar
					view={activeView}
					types={types}
					visibleCount={summary.count}
					visibleSize={summary.size}
					resultMode={resultMode}
					refreshing={storage.refreshing}
					busy={storage.reconciling}
					onQueryChange={setQueryInput}
					onTypesChange={(next) => setView({ types: next })}
					onVisibilityChange={(visibility) => setView({ visibility })}
					onUploadedChange={(uploaded) => setView({ uploaded })}
					onSourceChange={(source) => setView({ source })}
					onSortChange={(sort) => setView({ sort })}
					onClearFilters={() =>
						setView({
							types: [],
							visibility: 'all',
							uploaded: 'any',
							source: 'all',
						})
					}
					onRefresh={() => {
						void storage.reload(true);
						if (unusedMode) void reloadUnused();
					}}
					onReconcile={() => setConfirmReconcile(true)}
					onUpload={() => fileInputRef.current?.click()}
				/>

				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="sr-only"
					aria-label="Choose files to upload"
					onChange={(event) => {
						void storage.upload([...(event.target.files ?? [])]);
						event.target.value = '';
					}}
				/>
				<StorageUploads
					items={storage.uploads}
					onCancel={storage.cancelUpload}
					onDismiss={storage.dismissUpload}
				/>

				{storage.loading || (unusedMode && unusedLoading) ? (
					<div className="flex flex-1 items-center justify-center gap-3 text-muted-foreground text-sm">
						<Spinner /> Loading files…
					</div>
				) : storage.loadError ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
						<p className="font-medium">{storage.loadError}</p>
						<Button variant="outline" onClick={() => void storage.reload()}>
							Try again
						</Button>
					</div>
				) : (
					<StorageList
						folders={visibleFolders}
						files={visibleFiles}
						currentFolder={view.path}
						resultMode={resultMode}
						selectedIds={selectedIds}
						onToggleSelected={toggleSelected}
						onSelectAll={selectAll}
						onOpenFolder={(name) => openFolder(joinPath(view.path, name))}
						onNavigatePath={openFolder}
						onPreview={(file) => setView({ file: file.id })}
						onDownload={(file) => void storage.download(file)}
						onShare={setSharing}
						onMove={(selection) =>
							setMoving({ kind: 'files', files: selection })
						}
						onMoveFolder={(name) =>
							setMoving({
								kind: 'folder',
								name,
								path: joinPath(view.path, name),
							})
						}
						onDelete={(file) => {
							setDeleteError(undefined);
							setDeleting({ kind: 'file', file });
						}}
						onRenameFile={renameFileInline}
						onRenameFolder={renameFolderInline}
						onDeleteFolder={(name) => {
							setDeleteError(undefined);
							setDeleting({ kind: 'folder', name });
						}}
						onDropFiles={storage.moveMany}
						onDropFolder={storage.moveFolder}
					/>
				)}
			</div>

			{/* Both of these float above the list. Rendering them in the flow moved
			    the table the instant a checkbox was ticked or a drag began. */}
			<StorageSelection
				count={selectedFiles.length}
				busy={dialogBusy || bulkDownloadOpen}
				onMove={() => setMoving({ kind: 'files', files: selectedFiles })}
				onDownload={() => void startBulkDownload()}
				onDelete={() => {
					setDeleteError(undefined);
					setDeleting({ kind: 'bulk', files: selectedFiles });
				}}
				onClear={clearSelection}
			/>

			{draggingUpload ? (
				<div className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center">
					<p className="rounded-xl bg-popover px-4 py-3 font-medium text-sm shadow-lg">
						Drop to upload into {view.path ?? 'Storage'}
					</p>
				</div>
			) : null}

			<StoragePreview
				file={preview}
				onClose={() => setView({ file: null })}
				onDownload={(file) => void storage.download(file)}
			/>
			<StorageShare
				file={sharing}
				onClose={() => setSharing(undefined)}
				onChange={async (isPublic) =>
					sharing && togglePublic(sharing, isPublic)
				}
			/>
			<StorageMove
				target={moving}
				folders={folderPaths}
				onClose={() => setMoving(undefined)}
				onMove={moveFromDialog}
			/>
			<StorageDeleteDialog
				target={deleting}
				error={deleteError}
				busy={dialogBusy}
				onConfirm={() => void confirmDelete()}
				onClose={() => setDeleting(undefined)}
			/>
			<StorageBulkDownloadDialog
				open={bulkDownloadOpen}
				count={selectedFiles.length}
				progress={bulkDownloadProgress}
				error={bulkDownloadError}
				onCancel={cancelBulkDownload}
			/>
			<StorageReconcileDialog
				open={confirmReconcile}
				busy={storage.reconciling}
				onOpenChange={setConfirmReconcile}
				onConfirm={() => {
					void storage
						.reconcile()
						.then((ok) => ok && setConfirmReconcile(false));
				}}
			/>
		</section>
	);
}
