import type { MentionState } from '@web/lib/agent-mentions';
import { fileTypeIcon } from '@web/lib/storage';
import type { StoredFile } from '@web/lib/storage-api';
import { cn } from '@web/lib/utils';
import { FolderIcon, StickyNoteIcon } from 'lucide-react';

/**
 * One row of the mention list. Namespaces first (`@` alone), then the files
 * that match what is typed after `@f:`. Notes is a placeholder for the next
 * system that joins the mention grammar (`@n:`), visible so the shape of the
 * feature is discoverable, disabled because it does nothing yet.
 */
export type MentionOption =
	| { kind: 'namespace-files' }
	| { kind: 'namespace-notes' }
	| { kind: 'file'; file: StoredFile };

const FILE_RESULTS = 8;

export function mentionOptions(
	state: MentionState,
	files: readonly StoredFile[],
): MentionOption[] {
	if (state.stage === 'namespace')
		return [{ kind: 'namespace-files' }, { kind: 'namespace-notes' }];
	const query = state.query.toLowerCase();
	return files
		.filter(
			(file) =>
				file.name.toLowerCase().includes(query) ||
				(file.path ?? '').toLowerCase().includes(query),
		)
		.slice(0, FILE_RESULTS)
		.map((file) => ({ kind: 'file' as const, file }));
}

export function isMentionOptionDisabled(option: MentionOption) {
	return option.kind === 'namespace-notes';
}

/**
 * The typeahead panel above the composer field. It never takes focus: the
 * query lives in the textarea (`@f:…`), so the composer forwards arrow/Enter
 * keys and this only renders. `onMouseDown` prevents the default so a click
 * never blurs the textarea mid-edit.
 */
export function AgentMentionPicker({
	options,
	activeIndex,
	loading,
	onPick,
}: {
	options: readonly MentionOption[];
	activeIndex: number;
	loading: boolean;
	onPick: (option: MentionOption) => void;
}) {
	return (
		<div
			role="listbox"
			aria-label="Mention"
			className="absolute inset-x-2 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-md sm:left-2 sm:right-auto sm:w-80"
		>
			{options.length === 0 && (
				<p className="px-2 py-1.5 text-muted-foreground text-sm">
					{loading ? 'Loading files…' : 'No matching files.'}
				</p>
			)}
			{options.map((option, index) => {
				const active = index === activeIndex;
				const disabled = isMentionOptionDisabled(option);
				const rowClass = cn(
					'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
					active && !disabled && 'bg-accent text-accent-foreground',
					disabled && 'text-muted-foreground opacity-60',
				);
				if (option.kind === 'namespace-files')
					return (
						<button
							key="namespace-files"
							type="button"
							role="option"
							aria-selected={active}
							className={rowClass}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => onPick(option)}
						>
							<FolderIcon className="size-4" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">Files</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								@f:
							</span>
						</button>
					);
				if (option.kind === 'namespace-notes')
					return (
						<button
							key="namespace-notes"
							type="button"
							role="option"
							aria-selected={false}
							aria-disabled="true"
							disabled
							className={rowClass}
						>
							<StickyNoteIcon className="size-4" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">Notes</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								Coming soon
							</span>
						</button>
					);
				const Icon = fileTypeIcon(option.file.contentType);
				return (
					<button
						key={option.file.id}
						type="button"
						role="option"
						aria-selected={active}
						className={rowClass}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onPick(option)}
					>
						<Icon className="size-4" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{option.file.name}</span>
						{/* The folder, not the size: two files worth telling apart here
						    are two versions of the same name in different folders, and
						    the byte count says nothing about which one is which. */}
						<span className="min-w-0 max-w-[45%] shrink truncate text-muted-foreground text-xs">
							{option.file.path ?? 'Root'}
						</span>
					</button>
				);
			})}
		</div>
	);
}
