import type { Block } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { Button } from '@web/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import { Spinner } from '@web/components/ui/spinner';
import { authenticatedApi } from '@web/lib/authenticated-api';
import { diffNoteVersions, type NoteVersionDiff } from '@web/lib/notes-diff';
import type { NotesPreferences } from '@web/lib/notes-preferences';
import {
	type RefObject,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from 'react';

/** Enough to cover a long editing session without rendering years of history. */
const VERSION_PAGE_SIZE = 50;

const versionFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
	timeStyle: 'short',
});

function HistorySnapshotPreview({ content }: { content: Block[] }) {
	const editor = useCreateBlockNote({ initialContent: content });
	return (
		<BlockNoteView
			editor={editor}
			editable={false}
			slashMenu={false}
			theme="dark"
		/>
	);
}

/**
 * Marks the rendered blocks so the preview shows what restoring would change.
 *
 * BlockNote owns this DOM, so the classes are applied as a `data-diff`
 * attribute after it renders rather than through its component tree. If
 * BlockNote ever stops emitting `data-id`, the preview simply renders without
 * highlighting instead of breaking.
 */
function useDiffHighlight(
	container: RefObject<HTMLDivElement | null>,
	diff: NoteVersionDiff | undefined,
) {
	useEffect(() => {
		const node = container.current;
		if (!node) return;
		// One frame later: BlockNote renders the snapshot into this container, and
		// the elements to mark only exist once it has.
		const frame = requestAnimationFrame(() => {
			// BlockNote repeats `data-id` on an outer wrapper too, so only the
			// container is marked: one element per block, and its first child holds
			// the block's own content without the nested children below it.
			for (const element of node.querySelectorAll(
				'[data-node-type="blockContainer"][data-id]',
			)) {
				const status = diff?.status[element.getAttribute('data-id') ?? ''];
				if (status) element.setAttribute('data-diff', status);
				else element.removeAttribute('data-diff');
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [container, diff]);
}

function DiffSummary({ diff }: { diff: NoteVersionDiff }) {
	if (diff.identical)
		return (
			<span className="text-muted-foreground">
				Identical to the current note
			</span>
		);

	const parts = [
		diff.restored.length > 0 && {
			key: 'restored',
			text: `${diff.restored.length} restored`,
			className: 'text-emerald-400',
		},
		diff.changed.length > 0 && {
			key: 'changed',
			text: `${diff.changed.length} changed`,
			className: 'text-amber-400',
		},
		diff.moved.length > 0 && {
			key: 'moved',
			text: `${diff.moved.length} moved`,
			className: 'text-sky-400',
		},
		diff.removedCount > 0 && {
			key: 'removed',
			text: `${diff.removedCount} dropped`,
			className: 'text-rose-400',
		},
	].filter((part) => part !== false);

	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			{parts.map((part) => (
				<span key={part.key} className={part.className}>
					{part.text}
				</span>
			))}
		</span>
	);
}

export function NoteHistory({
	noteId,
	preferences,
	open,
	onOpenChange,
	onRestore,
	getCurrentContent,
}: {
	noteId: string;
	preferences: NotesPreferences;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestore: (content: Block[]) => Promise<void>;
	/** Read when the dialog opens, so the diff compares against what is on screen. */
	getCurrentContent: () => Block[];
}) {
	const [versions, setVersions] = useState<number[]>([]);
	const [selectedVersion, setSelectedVersion] = useState<number>();
	const [preview, setPreview] = useState<Block[]>();
	const [listLoading, setListLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [error, setError] = useState('');
	const readCurrentContent = useEffectEvent(getCurrentContent);
	const previewCache = useRef(new Map<number, Block[]>());
	const previewRequest = useRef(0);
	const previewContainer = useRef<HTMLDivElement>(null);
	const [currentContent, setCurrentContent] = useState<Block[]>([]);
	// Memoised so the highlight effect runs when the comparison changes, not on
	// every render of the dialog.
	const diff = useMemo(
		() => (preview ? diffNoteVersions(preview, currentContent) : undefined),
		[preview, currentContent],
	);

	useDiffHighlight(previewContainer, diff);

	useEffect(() => {
		if (!open) return;
		setCurrentContent(readCurrentContent());
		previewCache.current.clear();
		setVersions([]);
		setHasMore(false);
		setSelectedVersion(undefined);
		setPreview(undefined);
		setError('');
		setListLoading(true);
		void authenticatedApi
			.notes({ id: noteId })
			.mutations.get({ query: { limit: VERSION_PAGE_SIZE } })
			.then((response) => {
				if (
					response.status !== 200 ||
					!response.data ||
					!('versions' in response.data)
				) {
					setError('Could not load version history.');
					return;
				}
				const timestamps = response.data.versions.map(
					(version) => version.createdAt,
				);
				setVersions(timestamps);
				setHasMore(response.data.hasMore);
				setSelectedVersion(timestamps[0]);
			})
			.catch(() => setError('Could not load version history.'))
			.finally(() => setListLoading(false));
	}, [noteId, open]);

	const loadOlderVersions = async () => {
		const oldest = versions.at(-1);
		if (oldest === undefined || loadingMore) return;
		setLoadingMore(true);
		try {
			const response = await authenticatedApi
				.notes({ id: noteId })
				.mutations.get({
					query: { limit: VERSION_PAGE_SIZE, before: oldest },
				});
			if (
				response.status !== 200 ||
				!response.data ||
				!('versions' in response.data)
			) {
				setError('Could not load older versions.');
				return;
			}
			setVersions((current) => [
				...current,
				...response.data.versions.map((version) => version.createdAt),
			]);
			setHasMore(response.data.hasMore);
		} catch {
			setError('Could not load older versions.');
		} finally {
			setLoadingMore(false);
		}
	};

	useEffect(() => {
		if (!open || selectedVersion === undefined) return;
		const cached = previewCache.current.get(selectedVersion);
		if (cached) {
			setPreview(cached);
			setPreviewLoading(false);
			return;
		}

		const request = ++previewRequest.current;
		setPreview(undefined);
		setPreviewLoading(true);
		setError('');
		void authenticatedApi
			.notes({ id: noteId })
			.mutations({ createdAt: selectedVersion })
			.get()
			.then((response) => {
				if (request !== previewRequest.current) return;
				if (
					response.status !== 200 ||
					!response.data ||
					!('content' in response.data)
				) {
					setError('Could not load this snapshot.');
					return;
				}
				previewCache.current.set(selectedVersion, response.data.content);
				setPreview(response.data.content);
			})
			.catch(() => {
				if (request === previewRequest.current)
					setError('Could not load this snapshot.');
			})
			.finally(() => {
				if (request === previewRequest.current) setPreviewLoading(false);
			});

		return () => {
			previewRequest.current += 1;
		};
	}, [noteId, open, selectedVersion]);

	const restore = async () => {
		if (!preview) return;
		await onRestore(preview);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="h-[min(48rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-6xl">
				<DialogHeader className="border-b px-6 py-5 pr-14">
					<DialogTitle>Version history</DialogTitle>
					<DialogDescription>
						Preview a snapshot before restoring it as a new version.
					</DialogDescription>
				</DialogHeader>
				<div className="grid min-h-0 grid-rows-[minmax(10rem,35%)_minmax(0,1fr)] md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1">
					<aside className="min-h-0 overflow-y-auto border-b p-3 md:border-r md:border-b-0">
						{listLoading ? (
							<div className="grid min-h-32 place-items-center">
								<Spinner />
							</div>
						) : versions.length === 0 ? (
							<p className="px-3 py-8 text-center text-sm text-muted-foreground">
								{error || 'No synced versions yet.'}
							</p>
						) : (
							<ul className="space-y-1">
								{versions.map((createdAt, index) => (
									<li key={createdAt}>
										<Button
											variant={
												selectedVersion === createdAt ? 'secondary' : 'ghost'
											}
											className="h-auto w-full justify-start px-3 py-2 text-left"
											onClick={() => setSelectedVersion(createdAt)}
											aria-pressed={selectedVersion === createdAt}
										>
											<span>
												<span className="block text-sm font-medium">
													{versionFormat.format(createdAt)}
												</span>
												<span className="block text-xs text-muted-foreground">
													{index === 0
														? 'Current server version'
														: // Counted from the newest: the list is paged, so its
															// length is not the number of versions that exist.
															`${index} ${index === 1 ? 'version' : 'versions'} back`}
												</span>
											</span>
										</Button>
									</li>
								))}
								{hasMore && (
									<li>
										<Button
											variant="ghost"
											className="w-full justify-center text-xs text-muted-foreground"
											disabled={loadingMore}
											onClick={() => void loadOlderVersions()}
										>
											{loadingMore ? <Spinner /> : null}
											Load older versions
										</Button>
									</li>
								)}
							</ul>
						)}
					</aside>
					<section
						className="flex min-h-0 min-w-0 flex-col"
						aria-label="Snapshot preview"
					>
						<div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2">
							<div className="min-w-0">
								<p className="text-sm font-medium">Snapshot preview</p>
								<p className="text-xs">
									{diff && !previewLoading ? (
										<DiffSummary diff={diff} />
									) : (
										<span className="text-muted-foreground">
											Compared against the note as it is now
										</span>
									)}
								</p>
							</div>
							<Button
								size="sm"
								disabled={!preview || previewLoading || diff?.identical}
								onClick={() => void restore()}
							>
								Restore selected version
							</Button>
						</div>
						<div
							ref={previewContainer}
							className="notes-history-preview min-h-0 flex-1 overflow-y-auto overscroll-contain"
							data-font-size={preferences.fontSize}
							data-margins={preferences.margins}
						>
							{previewLoading ? (
								<div className="grid h-full place-items-center">
									<Spinner />
								</div>
							) : preview && selectedVersion !== undefined ? (
								<HistorySnapshotPreview
									key={selectedVersion}
									content={preview}
								/>
							) : (
								<p className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
									{error || 'Select a version to preview it.'}
								</p>
							)}
						</div>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
