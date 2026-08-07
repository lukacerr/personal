import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
	ChevronDownIcon,
	ChevronUpIcon,
	ReplaceIcon,
	XIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

export function NoteFind({
	mode,
	query,
	replacement,
	resultCount,
	currentIndex,
	focusRequest,
	onModeChange,
	onQueryChange,
	onReplacementChange,
	onNext,
	onPrevious,
	onReplace,
	onReplaceAll,
	onClose,
}: {
	mode: 'find' | 'replace';
	query: string;
	replacement: string;
	resultCount: number;
	currentIndex: number | null;
	/** Bumped by the opener to pull focus back into the field on every reopen. */
	focusRequest: number;
	onModeChange: (mode: 'find' | 'replace') => void;
	onQueryChange: (query: string) => void;
	onReplacementChange: (replacement: string) => void;
	onNext: () => void;
	onPrevious: () => void;
	onReplace: () => void;
	onReplaceAll: () => void;
	onClose: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const preserveSearchFocus = (event: React.PointerEvent<HTMLButtonElement>) =>
		event.preventDefault();

	// biome-ignore lint/correctness/useExhaustiveDependencies: focusRequest is the trigger, not an input.
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [focusRequest]);

	const resultLabel =
		resultCount === 0 ? '0 / 0' : `${(currentIndex ?? 0) + 1} / ${resultCount}`;

	return (
		// Biome recommends the newer search element, which happy-dom/React's test DOM does not recognize yet.
		// biome-ignore lint/a11y/useSemanticElements: role=search keeps the landmark compatible across supported webviews.
		<div
			role="search"
			className="absolute top-3 right-3 left-3 z-50 ml-auto flex max-w-md flex-col gap-1 rounded-2xl border bg-popover p-1 shadow-lg sm:left-auto"
		>
			<div className="flex min-w-0 items-center gap-1">
				<Input
					ref={inputRef}
					type="text"
					role="searchbox"
					aria-label="Find in note"
					placeholder="Find in note"
					value={query}
					className="h-8 min-w-0 flex-1 bg-transparent text-sm sm:w-56 sm:flex-none"
					onChange={(event) => onQueryChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							onClose();
						} else if (event.key === 'Enter') {
							event.preventDefault();
							if (event.shiftKey) onPrevious();
							else onNext();
						}
					}}
				/>
				<span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
					{resultLabel}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					disabled={resultCount === 0}
					onPointerDown={preserveSearchFocus}
					onClick={onPrevious}
					aria-label="Previous match"
				>
					<ChevronUpIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					disabled={resultCount === 0}
					onPointerDown={preserveSearchFocus}
					onClick={onNext}
					aria-label="Next match"
				>
					<ChevronDownIcon />
				</Button>
				<Button
					type="button"
					variant={mode === 'replace' ? 'secondary' : 'ghost'}
					size="icon-xs"
					onPointerDown={preserveSearchFocus}
					onClick={() => onModeChange(mode === 'replace' ? 'find' : 'replace')}
					aria-label={mode === 'replace' ? 'Hide replace' : 'Show replace'}
					aria-keyshortcuts="Control+H"
				>
					<ReplaceIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onClose}
					aria-label="Close find"
				>
					<XIcon />
				</Button>
			</div>
			{mode === 'replace' && (
				<div className="flex min-w-0 items-center gap-1">
					<Input
						type="text"
						aria-label="Replace with"
						placeholder="Replace with"
						value={replacement}
						className="h-8 min-w-0 flex-1 bg-transparent text-sm"
						onChange={(event) => onReplacementChange(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								onClose();
							} else if (event.key === 'Enter') {
								event.preventDefault();
								onReplace();
							}
						}}
					/>
					<Button
						type="button"
						variant="secondary"
						size="xs"
						disabled={resultCount === 0}
						onPointerDown={preserveSearchFocus}
						onClick={onReplace}
					>
						Replace
					</Button>
					<Button
						type="button"
						variant="secondary"
						size="xs"
						disabled={resultCount === 0}
						onPointerDown={preserveSearchFocus}
						onClick={onReplaceAll}
						aria-label="Replace all"
					>
						All
					</Button>
				</div>
			)}
		</div>
	);
}
