import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import type { StoredFileState } from '@web/lib/notes-files';
import {
	fileTypeIcon,
	fileTypeLabel,
	formatBytes,
	previewKind,
} from '@web/lib/storage';
import { cn } from '@web/lib/utils';
import {
	AlignCenterIcon,
	AlignLeftIcon,
	AlignRightIcon,
	DownloadIcon,
	EyeIcon,
	FileQuestionIcon,
	Globe2Icon,
	PaperclipIcon,
	RotateCwIcon,
	SquareIcon,
	TriangleAlertIcon,
} from 'lucide-react';
import {
	type PointerEvent as ReactPointerEvent,
	useRef,
	useState,
} from 'react';

/** Small enough to still be a handle, wide enough to still be an image. */
const MIN_MEDIA_WIDTH = 96;
/** How far one arrow key moves the edge. */
const RESIZE_STEP = 32;

export type MediaAlignment = 'left' | 'center' | 'right';

export type StoredFileViewProps = {
	state: StoredFileState;
	name: string;
	contentType: string;
	size: number;
	url?: string;
	/** Rendered width in pixels; `0` leaves the media at its natural size. */
	width?: number;
	alignment?: MediaAlignment;
	/** A light frame, so a screenshot with no background of its own has an edge. */
	bordered?: boolean;
	editable?: boolean;
	/** The note is published and this file is not, so a reader would see nothing. */
	unshared?: boolean;
	onRetry?: () => void;
	onPublish?: () => void;
	onChoose?: () => void;
	onDownload?: () => void;
	onPreview?: () => void;
	onResize?: (width: number) => void;
	onAlign?: (alignment: MediaAlignment) => void;
	onToggleBorder?: () => void;
	/** The media element could not load the bytes it was given. */
	onMediaError?: () => void;
};

function Notice({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: typeof FileQuestionIcon;
	title: string;
	description?: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 rounded-xl border border-dashed p-4">
			<Icon
				className="size-5 shrink-0 text-muted-foreground"
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm">{title}</p>
				{description ? (
					<p className="text-muted-foreground text-xs">{description}</p>
				) : null}
			</div>
			{action}
		</div>
	);
}

/** Alignment and framing, shown over the media while the pointer is on it. */
function MediaControls({
	alignment,
	bordered,
	onAlign,
	onToggleBorder,
}: {
	alignment: MediaAlignment;
	bordered: boolean;
	onAlign: (alignment: MediaAlignment) => void;
	onToggleBorder: () => void;
}) {
	const alignments = [
		['left', AlignLeftIcon, 'Align left'],
		['center', AlignCenterIcon, 'Align centre'],
		['right', AlignRightIcon, 'Align right'],
	] as const;

	return (
		<>
			{alignments.map(([value, Icon, label]) => (
				<Button
					key={value}
					size="icon-sm"
					variant={alignment === value ? 'secondary' : 'ghost'}
					aria-label={label}
					aria-pressed={alignment === value}
					onClick={() => onAlign(value)}
				>
					<Icon />
				</Button>
			))}
			<span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
			<Button
				size="icon-sm"
				variant={bordered ? 'secondary' : 'ghost'}
				aria-label="Toggle border"
				aria-pressed={bordered}
				onClick={onToggleBorder}
			>
				<SquareIcon />
			</Button>
		</>
	);
}

/**
 * Media the reader can size to taste.
 *
 * The handle is focusable and answers to the arrow keys as well as to a drag:
 * a size that can only be set by dragging is a size a keyboard cannot set at
 * all. The width is committed when the gesture ends rather than on every pixel,
 * so resizing writes one draft instead of a hundred.
 */
function ResizableMedia({
	width,
	editable,
	onResize,
	className,
	controls,
	children,
}: {
	width: number;
	editable: boolean;
	onResize?: (width: number) => void;
	className?: string;
	controls?: React.ReactNode;
	children: React.ReactNode;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const live = useRef<number | undefined>(undefined);
	const [dragging, setDragging] = useState<number | undefined>(undefined);
	const shown = dragging ?? (width || undefined);

	const clamp = (value: number) => {
		// Measured against the block's own container rather than this frame's
		// parent: the parent hugs the media now, so using it would cap the width
		// at whatever the media already is and resizing could only ever shrink.
		const limit =
			frame.current?.closest('.bn-block-content')?.clientWidth ??
			frame.current?.parentElement?.clientWidth ??
			Number.MAX_SAFE_INTEGER;
		return Math.round(Math.min(Math.max(value, MIN_MEDIA_WIDTH), limit));
	};

	const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!onResize) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const startX = event.clientX;
		const startWidth = frame.current?.clientWidth ?? MIN_MEDIA_WIDTH;
		handle.setPointerCapture(event.pointerId);

		const move = (moved: PointerEvent) => {
			live.current = clamp(startWidth + (moved.clientX - startX));
			setDragging(live.current);
		};
		const stop = (ended: PointerEvent) => {
			handle.releasePointerCapture(ended.pointerId);
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', stop);
			handle.removeEventListener('pointercancel', stop);
			setDragging(undefined);
			if (live.current !== undefined) onResize(live.current);
			live.current = undefined;
		};

		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', stop);
		handle.addEventListener('pointercancel', stop);
	};

	return (
		<div
			ref={frame}
			className={cn('group/media relative w-fit max-w-full', className)}
			style={{ width: shown ? `${shown}px` : undefined }}
		>
			{children}
			{controls ? (
				<div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/media:opacity-100">
					<div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-popover/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-sm">
						{controls}
					</div>
				</div>
			) : null}
			{editable && onResize ? (
				<button
					type="button"
					aria-label="Resize"
					className="-right-1 absolute inset-y-0 w-2 cursor-ew-resize rounded-full opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none group-hover/media:opacity-100"
					onPointerDown={startDrag}
					onKeyDown={(event) => {
						const delta =
							event.key === 'ArrowRight'
								? RESIZE_STEP
								: event.key === 'ArrowLeft'
									? -RESIZE_STEP
									: 0;
						if (delta === 0) return;
						event.preventDefault();
						onResize(
							clamp((frame.current?.clientWidth ?? MIN_MEDIA_WIDTH) + delta),
						);
					}}
				>
					<span className="mx-auto block h-full w-1 rounded-full bg-foreground/50" />
				</button>
			) : null}
		</div>
	);
}

/**
 * Everything the block can look like, with no editor and no network in sight,
 * so each state can be rendered and asserted on its own.
 */
export function StoredFileView({
	state,
	name,
	contentType,
	size,
	url,
	width = 0,
	alignment = 'left',
	bordered = false,
	editable = false,
	unshared,
	onRetry,
	onPublish,
	onChoose,
	onDownload,
	onPreview,
	onResize,
	onAlign,
	onToggleBorder,
	onMediaError,
}: StoredFileViewProps) {
	if (state === 'empty')
		return (
			<Button
				variant="outline"
				className="w-full justify-start"
				onClick={onChoose}
			>
				<PaperclipIcon data-icon="inline-start" />
				Choose or upload a file
			</Button>
		);

	if (state === 'loading')
		return (
			<div
				role="status"
				className="flex items-center gap-3 rounded-xl border p-4 text-muted-foreground text-sm"
			>
				<Spinner /> {name || 'Loading file…'}
			</div>
		);

	if (state === 'missing')
		return (
			<Notice
				icon={FileQuestionIcon}
				title={name ? `“${name}” was deleted` : 'This file was deleted'}
				description="It is no longer in Storage. The block stays so you know what was here."
			/>
		);

	if (state === 'broken')
		return (
			// All this state really knows is that the browser could not render the
			// bytes: the file may be damaged, in a format this browser will not
			// show, or gone from the bucket while its record stayed. Naming one of
			// those as the cause would be a guess, so it offers the file instead.
			<Notice
				icon={TriangleAlertIcon}
				title={`“${name}” could not be displayed`}
				description="Download it to check it, or reconcile storage if it went missing from the bucket."
				action={
					onDownload ? (
						<Button size="sm" variant="outline" onClick={onDownload}>
							<DownloadIcon data-icon="inline-start" /> Download
						</Button>
					) : null
				}
			/>
		);

	if (state === 'unavailable')
		return (
			<Notice
				icon={FileQuestionIcon}
				title="This file is not shared"
				description="The note is public but this attachment is not."
			/>
		);

	if (state === 'failed')
		return (
			<Notice
				icon={TriangleAlertIcon}
				title={`“${name}” could not be loaded`}
				description="Check your connection and try again."
				action={
					onRetry ? (
						<Button size="sm" variant="outline" onClick={onRetry}>
							<RotateCwIcon data-icon="inline-start" /> Retry
						</Button>
					) : null
				}
			/>
		);

	const kind = previewKind(contentType);
	const Icon = fileTypeIcon(contentType);
	const isMedia = kind === 'image' || kind === 'video' || kind === 'audio';

	// Alignment moves the hugged box the media rather than staying the width of the
	// note: a selection outline stretching past a half-width image reads as a
	// mistake. Alignment moves that box inside the full-width figure.
	const alignmentClass =
		alignment === 'center'
			? 'mx-auto'
			: alignment === 'right'
				? 'ml-auto'
				: 'mr-auto';

	// BlockNote draws the selection outline on the child of `.bn-block-content`,
	// which is this figure. Forcing it full width drew a box the width of the
	// note around a half-width image; hugging the media is what makes the
	// selection look like it belongs to what is selected.
	return (
		<figure
			className={cn(
				'my-1 flex flex-col gap-2',
				isMedia && url ? cn('w-fit max-w-full', alignmentClass) : 'w-full',
			)}
		>
			{unshared ? (
				<p className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-4 py-3 text-muted-foreground text-sm">
					<Globe2Icon className="size-4 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1">
						This note is public but “{name}” is not, so nobody opening the link
						will see it.
					</span>
					{onPublish ? (
						<Button size="sm" variant="outline" onClick={onPublish}>
							Share this file too
						</Button>
					) : null}
				</p>
			) : null}

			{isMedia && url ? (
				<ResizableMedia
					width={width}
					editable={editable}
					onResize={onResize}
					controls={
						editable && onAlign && onToggleBorder ? (
							<MediaControls
								alignment={alignment}
								bordered={bordered}
								onAlign={onAlign}
								onToggleBorder={onToggleBorder}
							/>
						) : null
					}
				>
					{kind === 'image' ? (
						<img
							src={url}
							alt={name}
							className={cn(
								'max-h-[70vh] w-full rounded-xl object-contain',
								bordered && 'ring-1 ring-border',
							)}
							onError={onMediaError}
						/>
					) : kind === 'video' ? (
						// biome-ignore lint/a11y/useMediaCaption: a stored video carries no track
						<video
							src={url}
							controls
							className={cn(
								'max-h-[70vh] w-full rounded-xl',
								bordered && 'ring-1 ring-border',
							)}
							onError={onMediaError}
						/>
					) : (
						// biome-ignore lint/a11y/useMediaCaption: a stored audio file carries no track
						<audio
							src={url}
							controls
							className="w-full"
							onError={onMediaError}
						/>
					)}
				</ResizableMedia>
			) : (
				// Anything without a viewer worth embedding — a pdf included — is a
				// reference. Opening it is one click away, in the same viewer Storage
				// uses, rather than a document reader wedged into the middle of a note.
				<div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
					<Icon
						className="size-6 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-sm">{name}</p>
						<p className="text-muted-foreground text-xs">
							{fileTypeLabel(contentType)} · {formatBytes(size)}
						</p>
					</div>
					{onPreview ? (
						<Button
							size="sm"
							variant="outline"
							onClick={onPreview}
							aria-label={`Preview ${name}`}
						>
							<EyeIcon data-icon="inline-start" /> Preview
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						onClick={onDownload}
						aria-label={`Download ${name}`}
					>
						<DownloadIcon data-icon="inline-start" /> Download
					</Button>
				</div>
			)}
		</figure>
	);
}
