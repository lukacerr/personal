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
import { Kbd } from '@web/components/ui/kbd';
import { Spinner } from '@web/components/ui/spinner';
import type { CalendarEvent } from '@web/lib/calendar-api';
import { Fragment } from 'react';

/**
 * The one dialog left standing. The event form died on purpose — creating
 * and editing is text, through the quick-add grammar — but a destructive
 * confirmation is a button, not a picker, and WebKitGTK has no quarrel with
 * buttons.
 */
export function EventDeleteDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target: CalendarEvent | undefined;
	busy: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete this event?</DialogTitle>
					<DialogDescription>
						{target?.recurrence
							? `"${target.title}" repeats, so deleting it removes every occurrence — the already-checked ones included.`
							: `"${target?.title}" will be gone for good.`}
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Keep it</Button>} />
					<Button variant="destructive" disabled={busy} onClick={onConfirm}>
						{busy ? <Spinner /> : null} Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const BINDINGS: Array<[string, string]> = [
	['a', 'Focus the add line'],
	['↑ ↓', 'Select the previous / next row'],
	['← →', 'Jump between the days and the side panel'],
	['Space', 'Toggle done on the selection'],
	['e', 'Edit the selection in place'],
	['c', 'Clone the selection and edit the copy'],
	['d', 'Show / hide what is done'],
	['f', 'Open the tag filter'],
	['Ctrl+↑↓', 'Move the selected one-off a day'],
	['Del', 'Delete the selection (asks first)'],
	['Ctrl+Z', 'Undo the last change'],
	['Ctrl+Alt+B', 'Fold the side panel'],
	['Esc', 'Drop the selection or cancel an edit'],
	['?', 'This sheet'],
];

const GRAMMAR: Array<[string, string]> = [
	['08/16 12:00 Título', 'Date and time, both optional; today assumed'],
	['[tag]', 'Tags the event'],
	['!b', 'Sends it to the backlog'],
	['*d · *3d · *月木 · *15', 'Daily · every 3 days · weekly by day'],
	['<12/15', 'Last day the series runs (with a repeat)'],
	['Shift+Enter', 'Detail lines under the first'],
];

/** `?` opens it: the keys and the grammar, so neither has to be remembered. */
export function KeybindsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Keys & grammar</DialogTitle>
					<DialogDescription>
						Everything here also works by touch; the keys are the fast path.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
					{/* Two aligned columns, keys left and words right beside them:
					    justify-between across a narrow card read as rubble. */}
					<dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
						{BINDINGS.map(([keys, what]) => (
							<Fragment key={keys}>
								<dt>
									<Kbd className="whitespace-nowrap">{keys}</Kbd>
								</dt>
								<dd className="text-muted-foreground">{what}</dd>
							</Fragment>
						))}
					</dl>
					<dl className="flex flex-col gap-2.5 text-sm">
						{GRAMMAR.map(([form, what]) => (
							<div key={form} className="flex flex-col gap-0.5">
								<dt className="font-mono text-xs tabular-nums">{form}</dt>
								<dd className="text-muted-foreground">{what}</dd>
							</div>
						))}
					</dl>
				</div>
			</DialogContent>
		</Dialog>
	);
}
