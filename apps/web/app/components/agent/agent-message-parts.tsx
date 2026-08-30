import { Reasoning } from '@web/components/agent/elements/reasoning';
import { Response } from '@web/components/agent/elements/response';
import { Shimmer } from '@web/components/agent/elements/shimmer';
import { Sources } from '@web/components/agent/elements/sources';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { Button } from '@web/components/ui/button';
import {
	type StorageReadResult,
	storageReadFile,
	storageSearchFiles,
	storageSearchLabel,
	tavilyQuery,
	tavilySources,
} from '@web/lib/agent';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { splitFileMentions } from '@web/lib/agent-mentions';
import { fileTypeIcon, formatBytes } from '@web/lib/storage';
import { getFileLink, type StoredFile } from '@web/lib/storage-api';
import { useStorageStore } from '@web/lib/storage-store';
import { getToolOrDynamicToolName, isToolUIPart } from 'ai';
import { EyeIcon, FileIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

async function downloadStoredFile(file: StoredFile) {
	try {
		window.location.assign(await getFileLink(file.id, 'attachment'));
	} catch {
		toast.error(`“${file.name}” could not be downloaded.`);
	}
}

/**
 * A `@f:<id>` token in the user's words, shown as the file it names — and
 * openable in place, so reading what was attached never requires a trip to
 * the Storage screen. The lookup subscribes to just the one row so a
 * background storage refresh re-renders this chip only when it changed; an id
 * the index does not know degrades to the raw token — the only truthful thing
 * left.
 */
function FileMentionChip({ fileId, token }: { fileId: string; token: string }) {
	const file = useStorageStore((state) =>
		state.files.find((entry) => entry.id === fileId),
	);
	const [previewing, setPreviewing] = useState(false);
	if (!file) return <>{token}</>;
	return (
		<>
			<button
				type="button"
				className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 align-baseline font-medium hover:bg-accent"
				aria-label={`Preview ${file.name}`}
				onClick={() => setPreviewing(true)}
			>
				<FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{file.name}</span>
			</button>
			{previewing && (
				<StoragePreview
					file={file}
					onClose={() => setPreviewing(false)}
					onDownload={(target) => void downloadStoredFile(target)}
				/>
			)}
		</>
	);
}

/** What the read tool answered with: the file, previewable in place. */
function StorageReadCard({ result }: { result: StorageReadResult }) {
	const file = useStorageStore((state) =>
		state.files.find((entry) => entry.id === result.fileId),
	);
	const [previewing, setPreviewing] = useState(false);
	const Icon = fileTypeIcon(result.mediaType);
	return (
		<div className="flex w-fit max-w-full items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-2.5 text-sm">
			<Icon className="size-4 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate font-medium">{result.name}</span>
			<span className="shrink-0 text-muted-foreground text-xs">
				{formatBytes(result.size)}
			</span>
			{/* The file can be gone by the time this row is read again. */}
			{file && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Preview ${result.name}`}
					onClick={() => setPreviewing(true)}
				>
					<EyeIcon aria-hidden="true" />
				</Button>
			)}
			{previewing && file && (
				<StoragePreview
					file={file}
					onClose={() => setPreviewing(false)}
					onDownload={(target) => void downloadStoredFile(target)}
				/>
			)}
		</div>
	);
}

/** User text with its mentions rendered as chips, otherwise verbatim. */
function UserText({ text }: { text: string }) {
	return (
		<p className="whitespace-pre-wrap break-words">
			{splitFileMentions(text).map((segment, index) =>
				segment.kind === 'text' ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are derived, order-stable text runs
					<span key={index}>{segment.text}</span>
				) : (
					<FileMentionChip
						// biome-ignore lint/suspicious/noArrayIndexKey: the same file can be mentioned twice
						key={index}
						fileId={segment.fileId}
						token={segment.token}
					/>
				),
			)}
		</p>
	);
}

/**
 * One message's parts, dispatched by type. Tool inputs and outputs are read
 * through the guards in `lib/agent` — never casts — so a malformed or
 * unknown part renders as something quiet instead of crashing the transcript.
 */
export function AgentMessageParts({
	message,
	isStreaming,
}: {
	message: AgentUIMessage;
	/** Whether this message is the one the stream is still writing. */
	isStreaming: boolean;
}) {
	return (
		<div className="flex w-full min-w-0 flex-col gap-2">
			{message.parts.map((part, index) => {
				const key = `${message.id}-${index}`;

				if (part.type === 'text')
					return message.role === 'user' ? (
						// The user's words are not markdown: rendering them as such
						// would silently reformat what they actually typed. File
						// mentions are the one exception, shown as the file they name.
						<UserText key={key} text={part.text} />
					) : (
						<Response key={key}>{part.text}</Response>
					);

				if (part.type === 'reasoning')
					return (
						<Reasoning
							key={key}
							text={part.text}
							isStreaming={isStreaming && part.state === 'streaming'}
						/>
					);

				if (isToolUIPart(part)) {
					const name = getToolOrDynamicToolName(part);
					if (name === 'storageSearch') {
						if (part.state === 'output-error')
							return (
								<p key={key} className="text-destructive text-sm">
									The file search failed: {part.errorText}
								</p>
							);
						if (part.state === 'output-available') {
							const files = storageSearchFiles(part.output);
							return (
								<p key={key} className="text-muted-foreground text-sm">
									{files.length === 0
										? 'No files matched.'
										: `Found ${files.length === 1 ? '1 file' : `${files.length} files`}: ${files.map((file) => file.name).join(', ')}`}
								</p>
							);
						}
						const label = storageSearchLabel(part.input);
						return (
							<Shimmer key={key} className="text-sm">
								{label ? `Searching files: ${label}…` : 'Searching files…'}
							</Shimmer>
						);
					}
					if (name === 'storageRead') {
						if (part.state === 'output-error')
							return (
								<p key={key} className="text-destructive text-sm">
									The file could not be read: {part.errorText}
								</p>
							);
						if (part.state === 'output-available') {
							const file = storageReadFile(part.output);
							if (!file)
								return (
									<p key={key} className="text-muted-foreground text-sm">
										Read a file
									</p>
								);
							return <StorageReadCard key={key} result={file} />;
						}
						return (
							<Shimmer key={key} className="text-sm">
								Reading file…
							</Shimmer>
						);
					}
					if (name === 'tavily') {
						if (part.state === 'output-error')
							return (
								<p key={key} className="text-destructive text-sm">
									The web search failed: {part.errorText}
								</p>
							);
						if (part.state === 'output-available')
							return <Sources key={key} sources={tavilySources(part.output)} />;
						const query = tavilyQuery(part.input);
						return (
							<Shimmer key={key} className="text-sm">
								{query ? `Searching: ${query}…` : 'Searching the web…'}
							</Shimmer>
						);
					}
					// A tool this build does not know how to render still happened.
					return (
						<p key={key} className="text-muted-foreground text-sm">
							Ran {name}
						</p>
					);
				}

				return null;
			})}
		</div>
	);
}
