import { Button } from '@web/components/ui/button';
import { Progress } from '@web/components/ui/progress';
import { formatBytes } from '@web/lib/storage';
import type { UploadItem } from '@web/lib/storage-upload';
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	UploadCloudIcon,
	XIcon,
} from 'lucide-react';

/**
 * Uploads live in their own panel rather than as ghost rows in the explorer:
 * the list shows files, and a file only exists once the server confirms it.
 */
export function StorageUploads({
	items,
	onCancel,
	onDismiss,
}: {
	items: UploadItem[];
	onCancel: (id: string) => void;
	onDismiss: (id: string) => void;
}) {
	if (items.length === 0) return null;

	const active = items.filter(
		(item) => item.status === 'pending' || item.status === 'uploading',
	);

	return (
		<section
			aria-label="Uploads"
			className="rounded-xl border bg-card shadow-sm"
		>
			<header className="flex items-center gap-3 border-b px-4 py-3">
				<h2 className="flex items-center gap-2 font-medium text-sm">
					<UploadCloudIcon className="size-4" aria-hidden="true" />
					{active.length > 0
						? `Uploading ${active.length} file${active.length === 1 ? '' : 's'}`
						: 'Uploads'}
				</h2>
			</header>

			<ul className="divide-y">
				{items.map((item) => (
					<li key={item.id} className="flex items-center gap-3 px-4 py-3">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								{item.status === 'completed' && (
									<CheckCircle2Icon
										className="size-4 shrink-0 text-emerald-500"
										aria-hidden="true"
									/>
								)}
								{item.status === 'failed' && (
									<AlertCircleIcon
										className="size-4 shrink-0 text-destructive"
										aria-hidden="true"
									/>
								)}
								<span className="truncate font-medium text-sm">
									{item.name}
								</span>
								<span className="shrink-0 text-muted-foreground text-xs">
									{formatBytes(item.size)}
								</span>
							</div>

							{(item.status === 'uploading' || item.status === 'pending') && (
								<Progress
									value={Math.round(item.progress * 100)}
									className="mt-2"
									aria-label={`Uploading ${item.name}`}
								/>
							)}

							{/* A failure is a condition that stays true, so it stays on the
							    row where it happened rather than in a toast that vanishes. */}
							{item.error && (
								<p className="mt-1 text-destructive text-xs">{item.error}</p>
							)}
							{item.status === 'cancelled' && (
								<p className="mt-1 text-muted-foreground text-xs">Cancelled.</p>
							)}
						</div>

						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={
								item.status === 'uploading' || item.status === 'pending'
									? `Cancel upload of ${item.name}`
									: `Dismiss ${item.name}`
							}
							onClick={() =>
								item.status === 'uploading' || item.status === 'pending'
									? onCancel(item.id)
									: onDismiss(item.id)
							}
						>
							<XIcon />
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
