import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
	InlineRename,
	type StorageActions,
	VIRTUALISE_ABOVE,
} from '@web/components/storage/storage-row';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
	fileTypeIcon,
	fileTypeLabel,
	formatBytes,
	parentFolder,
} from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { timestampLabel } from '@web/lib/utils';
import {
	ChevronLeftIcon,
	DownloadIcon,
	FolderIcon,
	MoreHorizontalIcon,
	MoveIcon,
	NotebookPenIcon,
	PencilIcon,
	Share2Icon,
	Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';

/** The touch layout: one card per entry, with every action behind its menu. */
export function StorageCards({
	folders,
	files,
	currentFolder,
	resultMode,
	selectedIds,
	actions,
	onToggle,
}: {
	folders: string[];
	files: StoredFile[];
	currentFolder: string | null;
	resultMode: boolean;
	selectedIds: Set<string>;
	actions: StorageActions;
	onToggle: (id: string) => void;
}) {
	const [editing, setEditing] = useState<string>();
	// Where the cards begin in the document, so the window's scroll position can
	// be read as a position in this list. The layout is always mounted —
	// `md:hidden` is CSS — so without its own windowing it renders every row
	// and cancels out the table's virtualisation.
	const [list, setList] = useState<HTMLUListElement | null>(null);
	const virtualised = files.length > VIRTUALISE_ABOVE;
	const rows = useWindowVirtualizer({
		count: virtualised ? files.length : 0,
		scrollMargin: list?.offsetTop ?? 0,
		// A file card is two meta lines tall; results carry their path as a third.
		estimateSize: () => (resultMode ? 112 : 96),
		overscan: 12,
	});
	const windowed = rows.getVirtualItems();
	// `start`/`end` are document positions — they include the margin — while
	// `getTotalSize()` is the height of the rows alone, so the margin comes off
	// both ends or the list stops short of its last card.
	const margin = rows.options.scrollMargin;
	const paddingTop = (windowed[0]?.start ?? 0) - margin;
	const paddingBottom =
		windowed.length > 0
			? rows.getTotalSize() - ((windowed.at(-1)?.end ?? 0) - margin)
			: 0;
	const visibleFiles = virtualised
		? windowed.flatMap((row) => files[row.index] ?? [])
		: files;
	return (
		<ul ref={setList} className="divide-y rounded-xl border bg-card md:hidden">
			{currentFolder && !resultMode ? (
				<li>
					<Button
						variant="ghost"
						className="h-16 w-full justify-start gap-3 px-4"
						onClick={() => actions.onNavigatePath(parentFolder(currentFolder))}
					>
						<ChevronLeftIcon /> <span className="font-medium">..</span>
						<span className="text-muted-foreground text-xs">Parent folder</span>
					</Button>
				</li>
			) : null}
			{folders.map((name) => (
				<li key={name} className="flex min-h-20 items-center gap-2 px-3">
					{editing === `folder:${name}` ? (
						<InlineRename
							value={name}
							label={`Rename folder ${name}`}
							onSave={(next) => actions.onRenameFolder(name, next)}
							onCancel={() => setEditing(undefined)}
						/>
					) : (
						<>
							{/* Only files can be selected, so this stands in for the
							    checkbox and keeps both kinds of row on one line. */}
							<span className="size-4 shrink-0" aria-hidden="true" />
							<Button
								variant="ghost"
								className="h-16 min-w-0 flex-1 justify-start gap-3 px-2"
								onClick={() => actions.onOpenFolder(name)}
							>
								<FolderIcon className="size-6 text-muted-foreground" />
								<span className="truncate font-medium">{name}</span>
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											size="icon"
											variant="ghost"
											aria-label={`Actions for folder ${name}`}
										/>
									}
								>
									<MoreHorizontalIcon />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuGroup>
										<DropdownMenuItem
											onClick={() => actions.onMoveFolder(name)}
										>
											<MoveIcon /> Move
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => setEditing(`folder:${name}`)}
										>
											<PencilIcon /> Rename
										</DropdownMenuItem>
									</DropdownMenuGroup>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => actions.onDeleteFolder(name)}
									>
										<Trash2Icon /> Delete
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					)}
				</li>
			))}
			{/* Real list items holding the height of what is scrolled past, so the
			    scrollbar still describes the whole list; two empty items is the
			    smaller cost, the same trade the table makes with its spacer rows. */}
			{virtualised && paddingTop > 0 ? (
				<li style={{ height: paddingTop }} />
			) : null}
			{visibleFiles.map((file) => {
				const Icon = fileTypeIcon(file.contentType);
				const selected = selectedIds.has(file.id);
				return (
					<li
						key={file.id}
						className="flex min-h-24 items-center gap-2 px-3 data-[selected=true]:bg-muted"
						data-selected={selected}
					>
						<Checkbox
							checked={selected}
							onCheckedChange={() => onToggle(file.id)}
							aria-label={`Select ${file.name}`}
						/>
						{editing === `file:${file.id}` ? (
							<InlineRename
								value={file.name}
								label={`Rename ${file.name}`}
								onSave={(name) => actions.onRenameFile(file, name)}
								onCancel={() => setEditing(undefined)}
							/>
						) : (
							<Button
								variant="ghost"
								className="h-20 min-w-0 flex-1 justify-start gap-3 px-2 text-left"
								onClick={() => actions.onPreview(file)}
							>
								<Icon className="size-6 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									{/* Beside the name, like the table does: appended to the meta
									    line it was the first thing `truncate` cut off. */}
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="truncate font-medium">{file.name}</span>
										{file.uploadedFromNotes ? (
											<NotebookPenIcon
												className="size-3.5 shrink-0 text-muted-foreground"
												aria-label="Uploaded from Notes"
											/>
										) : null}
									</span>
									<span className="block truncate text-muted-foreground text-xs">
										{fileTypeLabel(file.contentType)} · {formatBytes(file.size)}{' '}
										· {timestampLabel(file.createdAt)}
									</span>
									{resultMode ? (
										<span className="block truncate text-muted-foreground text-xs">
											{file.path ?? 'Root'}
										</span>
									) : null}
								</span>
							</Button>
						)}
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										size="icon"
										variant="ghost"
										aria-label={`Actions for ${file.name}`}
									/>
								}
							>
								<MoreHorizontalIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-52">
								<DropdownMenuGroup>
									<DropdownMenuItem onClick={() => actions.onDownload(file)}>
										<DownloadIcon /> Download
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => actions.onShare(file)}>
										<Share2Icon /> Share
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => actions.onMove([file])}>
										<MoveIcon /> Move
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setEditing(`file:${file.id}`)}
									>
										<PencilIcon /> Rename
									</DropdownMenuItem>
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={() => actions.onDelete(file)}>
									<Trash2Icon /> Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</li>
				);
			})}
			{virtualised && paddingBottom > 0 ? (
				<li style={{ height: paddingBottom }} />
			) : null}
		</ul>
	);
}
