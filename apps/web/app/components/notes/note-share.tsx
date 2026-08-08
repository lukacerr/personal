import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { Toggle } from '@web/components/ui/toggle';
import { CopyIcon, Globe2Icon, LockIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

export function publicNoteUrl(origin: string, id: string) {
	return `${origin}/public/notes?note=${id}`;
}

/**
 * Publishing is a decision worth a sentence, and the link it produces needs
 * somewhere to live, so both share one popover instead of a bare navbar toggle.
 */
export function NoteShare({
	noteId,
	isPublic,
	/** A note the server has never seen would publish a link to a 404. */
	canPublish,
	onChange,
	className,
	variant = 'icon',
}: {
	noteId: string;
	isPublic: boolean;
	canPublish: boolean;
	onChange: (isPublic: boolean) => Promise<boolean>;
	className?: string;
	variant?: 'icon' | 'menu';
}) {
	const [pending, setPending] = useState(false);
	const linkRef = useRef<HTMLInputElement>(null);
	const url =
		typeof window === 'undefined'
			? ''
			: publicNoteUrl(window.location.origin, noteId);

	const toggle = async (next: boolean) => {
		if (pending) return;
		setPending(true);
		try {
			const synced = await onChange(next);
			if (!synced)
				toast.error(
					navigator.onLine
						? 'The server rejected this visibility change.'
						: 'Sharing a note requires a connection.',
				);
		} catch {
			toast.error('This note could not be shared.');
		} finally {
			setPending(false);
		}
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast.success('Public link copied.');
		} catch {
			// Clipboard access can be denied; selecting the text still lets the user copy.
			linkRef.current?.select();
			toast.error('Copy the selected link manually.');
		}
	};

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						size={variant === 'menu' ? 'sm' : 'icon-sm'}
						variant="ghost"
						className={variant === 'menu' ? 'w-full justify-start' : className}
						aria-label="Share note"
					/>
				}
			>
				{variant === 'menu' ? (
					<>
						{isPublic ? <Globe2Icon /> : <LockIcon />}
						Share note
					</>
				) : isPublic ? (
					<Globe2Icon />
				) : (
					<LockIcon />
				)}
			</PopoverTrigger>
			<PopoverContent
				align="end"
				side={variant === 'menu' ? 'left' : 'bottom'}
				className="w-80"
			>
				<PopoverHeader>
					<PopoverTitle>Share note</PopoverTitle>
					<PopoverDescription>
						{canPublish
							? 'A public note is readable by anyone holding its link, without signing in.'
							: 'Save this note first: sharing it now would produce a link to a note the server does not have.'}
					</PopoverDescription>
				</PopoverHeader>
				<Toggle
					variant="outline"
					className="w-full justify-start"
					pressed={isPublic}
					disabled={!canPublish || pending}
					onPressedChange={(next) => void toggle(next)}
				>
					<Globe2Icon data-icon="inline-start" aria-hidden="true" />
					Public link
				</Toggle>
				{isPublic && (
					<div className="grid gap-2">
						<Input
							ref={linkRef}
							readOnly
							value={url}
							aria-label="Public note link"
							className="font-mono text-xs"
							onFocus={(event) => event.currentTarget.select()}
						/>
						<Button size="sm" variant="secondary" onClick={() => void copy()}>
							<CopyIcon data-icon="inline-start" aria-hidden="true" />
							Copy public link
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
