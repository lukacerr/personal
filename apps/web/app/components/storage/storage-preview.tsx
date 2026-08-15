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
import { Spinner } from '@web/components/ui/spinner';
import { formatBytes, previewKind, readTextPrefix } from '@web/lib/storage';
import { getFileLink, type StoredFile } from '@web/lib/storage-api';
import { DownloadIcon, FileQuestionIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Enough to read a file without freezing the tab on a huge one. */
const MAX_TEXT_BYTES = 256 * 1024;

type PreviewState =
	| { status: 'loading' }
	| { status: 'ready' }
	| { status: 'failed'; message: string };

export function StoragePreview({
	file,
	onClose,
	onDownload,
}: {
	file: StoredFile | undefined;
	onClose: () => void;
	onDownload: (file: StoredFile) => void;
}) {
	const [url, setUrl] = useState<string>();
	const [state, setState] = useState<PreviewState>({ status: 'loading' });
	const [text, setText] = useState<string>();
	const [rows, setRows] = useState<Array<Array<unknown>>>();
	const documentRef = useRef<HTMLDivElement>(null);
	const kind = file ? previewKind(file.contentType) : 'unknown';
	// The route recomputes `file` with `.find(...)` over an array the store
	// replaces on every mutation, so the same file arrives as a new object
	// whenever anything else changes. The effect keys on the fields it reads,
	// or renaming another file re-downloads the one being previewed.
	const fileId = file?.id;
	const contentType = file?.contentType ?? '';

	useEffect(() => {
		if (!fileId) return;
		let current = true;
		const controller = new AbortController();
		setState({ status: 'loading' });
		setText(undefined);
		setRows(undefined);
		setUrl(undefined);

		documentRef.current?.replaceChildren();

		(async () => {
			const link = await getFileLink(fileId, 'inline');
			if (!current) return;
			setUrl(link);

			// Media elements report their own readiness, so the dialog stops
			// waiting as soon as it has a URL to hand them. A type with no viewer
			// stops here too: downloading a file to then say nothing can render it
			// spends the whole file for a sentence.
			if (kind === 'pdf' || kind === 'unknown') {
				setState({ status: 'ready' });
				return;
			}
			if (kind === 'image' || kind === 'video' || kind === 'audio') return;

			const response = await fetch(link, { signal: controller.signal });
			if (!response.ok) throw new Error('The file could not be downloaded.');

			if (kind === 'text') {
				// Read the head of the file and hang up. A `Range` header would ask
				// storage to do the trimming, but a custom header turns this into a
				// preflighted request and adds a CORS rule the bucket must carry.
				setText(await readTextPrefix(response, MAX_TEXT_BYTES));
			} else if (kind === 'sheet') {
				const buffer = await response.arrayBuffer();
				setRows(await readSheet(buffer, contentType));
			} else if (kind === 'document') {
				const buffer = await response.arrayBuffer();
				const container = documentRef.current;
				if (!container) throw new Error('The preview could not be rendered.');
				// Loaded on demand: none of these renderers belong in the app shell.
				const { renderAsync } = await import('docx-preview');
				container.replaceChildren();
				await renderAsync(buffer, container, undefined, {
					className: 'docx',
					inWrapper: false,
				});
			}

			if (current) setState({ status: 'ready' });
		})().catch((error: unknown) => {
			if (!current) return;
			// A preview that cannot render says so, rather than spinning forever.
			setState({
				status: 'failed',
				message:
					error instanceof Error
						? error.message
						: 'This file could not be previewed.',
			});
		});

		return () => {
			current = false;
			controller.abort();
		};
	}, [contentType, fileId, kind]);

	if (!file) return null;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="grid max-h-[85vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] gap-4 md:h-[calc(100dvh-2rem)] md:max-h-none md:w-[calc(100vw-2rem)] md:max-w-none">
				<DialogHeader>
					<DialogTitle className="truncate">{file.name}</DialogTitle>
					<DialogDescription>
						{file.contentType} · {formatBytes(file.size)}
					</DialogDescription>
				</DialogHeader>

				<div className="relative min-h-64 overflow-auto rounded-lg border bg-muted/30 md:min-h-0">
					{state.status === 'loading' && (
						<div
							role="status"
							className="absolute inset-0 flex items-center justify-center gap-3 bg-background/70 text-muted-foreground text-sm"
						>
							<Spinner /> Loading preview…
						</div>
					)}

					{state.status === 'failed' && (
						<div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-center">
							<FileQuestionIcon
								className="size-8 text-muted-foreground"
								aria-hidden="true"
							/>
							<p className="font-medium text-sm">{state.message}</p>
							<p className="text-muted-foreground text-xs">
								You can still download the file.
							</p>
						</div>
					)}

					{url && kind === 'image' && (
						<img
							src={url}
							alt={file.name}
							className="mx-auto h-full w-full object-contain"
							onLoad={() => setState({ status: 'ready' })}
							onError={() =>
								setState({
									status: 'failed',
									message: 'This image could not be loaded.',
								})
							}
						/>
					)}
					{url && kind === 'video' && (
						// biome-ignore lint/a11y/useMediaCaption: a stored video carries no track
						<video
							src={url}
							controls
							className="mx-auto h-full w-full object-contain"
							onCanPlay={() => setState({ status: 'ready' })}
							onError={() =>
								setState({
									status: 'failed',
									message: 'This video could not be loaded.',
								})
							}
						/>
					)}
					{url && kind === 'audio' && (
						// biome-ignore lint/a11y/useMediaCaption: a stored audio file carries no track
						<audio
							src={url}
							controls
							className="w-full p-6"
							onCanPlay={() => setState({ status: 'ready' })}
							onError={() =>
								setState({
									status: 'failed',
									message: 'This audio file could not be loaded.',
								})
							}
						/>
					)}
					{url && kind === 'pdf' && (
						<iframe
							src={url}
							title={file.name}
							className="h-full min-h-[60vh] w-full md:min-h-0"
						/>
					)}
					{text !== undefined && (
						<pre className="overflow-auto p-4 font-mono text-xs leading-relaxed">
							{text}
							{file.size > MAX_TEXT_BYTES && '\n\n… truncated'}
						</pre>
					)}
					{rows && <SheetTable rows={rows} fileName={file.name} />}
					{/* A Word document carries colours chosen for white paper, so it is
					    rendered on a white sheet instead of the app's surface. */}
					<div
						ref={documentRef}
						className="flex flex-col items-center bg-white p-6 text-black [&:empty]:hidden"
					/>

					{state.status === 'ready' && kind === 'unknown' && (
						<div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-center">
							<FileQuestionIcon
								className="size-8 text-muted-foreground"
								aria-hidden="true"
							/>
							<p className="text-muted-foreground text-sm">
								No preview available for this file type.
							</p>
						</div>
					)}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
					<Button onClick={() => onDownload(file)}>
						<DownloadIcon data-icon="inline-start" aria-hidden="true" />
						Download
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Only the first rows: a spreadsheet preview is for recognising, not auditing. */
const MAX_SHEET_ROWS = 200;

async function readSheet(
	buffer: ArrayBuffer,
	contentType: string,
): Promise<Array<Array<unknown>>> {
	if (contentType.startsWith('text/csv')) {
		const { parse } = await import('papaparse');
		const parsed = parse<string[]>(new TextDecoder().decode(buffer), {
			skipEmptyLines: true,
		});
		return parsed.data.slice(0, MAX_SHEET_ROWS);
	}

	// The browser entry point: the package root does not resolve under Rolldown.
	const { default: readXlsx } = await import('read-excel-file/browser');
	const sheets = await readXlsx(new Blob([buffer]));
	// A workbook is a list of sheets; the preview shows the first one.
	const rows = sheets[0]?.data ?? [];
	return rows.slice(0, MAX_SHEET_ROWS);
}

function SheetTable({
	rows,
	fileName,
}: {
	rows: Array<Array<unknown>>;
	fileName: string;
}) {
	return (
		<div className="overflow-auto">
			<table className="w-full border-collapse text-sm">
				<caption className="sr-only">Preview of {fileName}</caption>
				<tbody>
					{rows.map((row, rowIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: spreadsheet cells have no identity beyond their position
						<tr key={rowIndex} className="even:bg-muted/40">
							{row.map((cell, cellIndex) => (
								<td
									// biome-ignore lint/suspicious/noArrayIndexKey: same reason
									key={cellIndex}
									className="max-w-64 truncate border px-3 py-1.5"
								>
									{cell instanceof Date
										? cell.toLocaleDateString()
										: String(cell ?? '')}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
