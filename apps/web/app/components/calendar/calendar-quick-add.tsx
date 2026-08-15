import { parseQuickAdd, type QuickAddParse } from '@web/lib/calendar';
import { PlusIcon } from 'lucide-react';
import { forwardRef, useState } from 'react';

/**
 * The one way in, living in the toolbar and speaking the whole grammar:
 * `08/16 12:00 Texto [tag] *火 <12/15`, `!b` for the backlog, Shift+Enter for
 * detail lines. Enter submits and keeps the focus so lines chain; the bare
 * `a` anywhere on the screen lands the caret here.
 */
export const CalendarQuickAdd = forwardRef<
	HTMLTextAreaElement,
	{
		today: string;
		onAdd: (parsed: QuickAddParse) => void;
		/** Tab hands the focus to the first row instead of the filter icons. */
		onTabOut: () => void;
	}
>(function CalendarQuickAdd({ today, onAdd, onTabOut }, ref) {
	const [value, setValue] = useState('');

	function submit() {
		const parsed = parseQuickAdd(value, today);
		if (!parsed) return;
		onAdd(parsed);
		setValue('');
	}

	return (
		<div className="flex min-w-0 flex-1 items-start gap-2 rounded-3xl border bg-background px-3 py-1.5 text-muted-foreground focus-within:border-ring focus-within:text-foreground">
			<PlusIcon aria-hidden className="mt-1 size-4 shrink-0" />
			<textarea
				ref={ref}
				aria-label="Quick add"
				// Quiet on purpose: a literal example reads as content and dizzies.
				placeholder="Add…"
				value={value}
				rows={Math.max(1, value.split('\n').length)}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
					if (event.key === 'Tab' && !event.shiftKey) {
						event.preventDefault();
						event.currentTarget.blur();
						onTabOut();
					}
					if (event.key === 'Escape') setValue('');
				}}
				className="w-full min-w-0 resize-none bg-transparent pt-0.5 text-sm outline-none placeholder:text-muted-foreground/60"
			/>
		</div>
	);
});
