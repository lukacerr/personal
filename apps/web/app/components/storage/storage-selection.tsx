import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import { DownloadIcon, MoveIcon, Trash2Icon, XIcon } from 'lucide-react';
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useReducedMotion,
} from 'motion/react';

/**
 * Floats over the list instead of sitting above it: appearing in the flow
 * pushed the whole table down the moment a checkbox was ticked, which moved the
 * next row out from under the pointer that was about to tick it.
 *
 * Fixed to the viewport rather than to the list: the page itself is what
 * scrolls, so anything positioned against the list ends up wherever the list
 * ends — which with a few thousand files is a long way below the fold.
 */
export function StorageSelection({
	count,
	busy,
	onMove,
	onDownload,
	onDelete,
	onClear,
}: {
	count: number;
	busy: boolean;
	onMove: () => void;
	onDownload: () => void;
	onDelete: () => void;
	onClear: () => void;
}) {
	const reduced = useReducedMotion();
	const offset = reduced ? 0 : 12;

	return (
		<LazyMotion features={domAnimation} strict>
			<AnimatePresence>
				{count > 0 ? (
					<m.div
						initial={{ opacity: 0, y: offset }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: offset }}
						transition={{ duration: 0.15, ease: 'easeOut' }}
						className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center p-4 sm:p-6"
					>
						<nav
							className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border bg-popover px-3 py-2 shadow-lg"
							aria-label="Selected files actions"
						>
							<p className="mr-2 font-medium text-sm">
								{count} {count === 1 ? 'file' : 'files'} selected
							</p>
							<Button
								size="sm"
								variant="outline"
								onClick={onMove}
								disabled={busy}
							>
								<MoveIcon data-icon="inline-start" /> Move
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={onDownload}
								disabled={busy}
							>
								{busy ? (
									<Spinner data-icon="inline-start" />
								) : (
									<DownloadIcon data-icon="inline-start" />
								)}
								<span className="hidden sm:inline">Download ZIP</span>
								<span className="sm:hidden">ZIP</span>
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={onDelete}
								disabled={busy}
							>
								<Trash2Icon data-icon="inline-start" /> Delete
							</Button>
							<Button
								size="icon-sm"
								variant="ghost"
								onClick={onClear}
								disabled={busy}
								aria-label="Clear selection"
							>
								<XIcon />
							</Button>
						</nav>
					</m.div>
				) : null}
			</AnimatePresence>
		</LazyMotion>
	);
}
