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
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import { Toggle } from '@web/components/ui/toggle';
import { env } from '@web/lib/env';
import type { StoredFile } from '@web/lib/storage-api';
import { CopyIcon, Globe2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

export function publicFileUrl(id: string) {
	return `${env.VITE_API_URL.replace(/\/$/, '')}/public/files/${id}`;
}

/** A dialog works consistently from cards, menus and narrow mobile viewports. */
export function StorageShare({
	file,
	onClose,
	onChange,
}: {
	file: StoredFile | undefined;
	onClose: () => void;
	onChange: (isPublic: boolean) => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const linkRef = useRef<HTMLInputElement>(null);
	if (!file) return null;
	const url = publicFileUrl(file.id);

	const toggle = async (next: boolean) => {
		if (pending) return;
		setPending(true);
		try {
			await onChange(next);
		} catch {
			toast.error(
				navigator.onLine
					? 'The server rejected this visibility change.'
					: 'Sharing a file requires a connection.',
			);
		} finally {
			setPending(false);
		}
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast.success('Public link copied.');
		} catch {
			linkRef.current?.select();
			toast.error('Copy the selected link manually.');
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Share {file.name}</DialogTitle>
					<DialogDescription>
						Anyone holding a public link can download this file without signing
						in.
					</DialogDescription>
				</DialogHeader>

				<Toggle
					variant="outline"
					className="w-full justify-start"
					pressed={file.isPublic}
					disabled={pending}
					onPressedChange={(next) => void toggle(next)}
				>
					{pending ? <Spinner data-icon="inline-start" /> : <Globe2Icon />}
					Public link
				</Toggle>

				{file.isPublic ? (
					<div className="flex flex-col gap-2">
						<Input
							ref={linkRef}
							readOnly
							value={url}
							aria-label="Public file link"
							className="font-mono text-xs"
							onFocus={(event) => event.currentTarget.select()}
						/>
						<Button variant="secondary" onClick={() => void copy()}>
							<CopyIcon data-icon="inline-start" />
							Copy public link
						</Button>
					</div>
				) : null}

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
