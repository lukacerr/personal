import { Button } from '@web/components/ui/button';
import type { NoteLoadFailure } from '@web/lib/notes-refresh';
import {
	CloudOffIcon,
	FilePlus2Icon,
	FileX2Icon,
	RotateCwIcon,
} from 'lucide-react';

const copy: Record<
	NoteLoadFailure,
	{ title: string; description: string; icon: typeof FileX2Icon }
> = {
	missing: {
		title: 'This note no longer exists',
		description:
			'It was deleted, or the link points to a note that was never on this account.',
		icon: FileX2Icon,
	},
	offline: {
		title: 'This note is not available offline',
		description:
			'It has never been opened on this device, so there is no local copy to read. It will load once you are back online.',
		icon: CloudOffIcon,
	},
	failed: {
		title: 'Could not open this note',
		description:
			'The server did not answer for this note. Nothing was lost — try again in a moment.',
		icon: RotateCwIcon,
	},
};

/**
 * What a selected note shows when it has nothing to render. A spinner here
 * would claim the note is still on its way when it is not coming.
 */
export function NoteUnavailable({
	reason,
	onRetry,
	onCreate,
}: {
	reason: NoteLoadFailure;
	onRetry: () => void;
	onCreate: () => void;
}) {
	const { title, description, icon: Icon } = copy[reason];
	return (
		<div className="grid flex-1 place-items-center px-6 text-center">
			<div className="max-w-sm" role="status">
				<Icon className="mx-auto size-10 text-muted-foreground/50" />
				<h1 className="mt-5 font-heading text-2xl font-semibold tracking-tight">
					{title}
				</h1>
				<p className="mt-2 text-sm leading-6 text-muted-foreground">
					{description}
				</p>
				<div className="mt-5 flex flex-wrap justify-center gap-2">
					{reason === 'missing' ? (
						<Button onClick={onCreate}>
							<FilePlus2Icon /> New note
						</Button>
					) : (
						<Button onClick={onRetry}>
							<RotateCwIcon /> Try again
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
