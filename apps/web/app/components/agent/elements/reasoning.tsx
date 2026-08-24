import { Response } from '@web/components/agent/elements/response';
import { Shimmer } from '@web/components/agent/elements/shimmer';
import { Button } from '@web/components/ui/button';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import { cn } from '@web/lib/utils';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * The model's thinking, folded away by default. While the answer has not
 * started, the thinking is the only sign of progress, so it follows the
 * stream: open while `isStreaming`, closed again when the answer takes over.
 * The first manual toggle ends that — a reader who opened it mid-stream keeps
 * it open, one who closed it is not fought with — so the open state derives
 * from the manual choice when there is one and from the stream when there is
 * none, with no effect needed to reconcile them.
 */
export function Reasoning({
	text,
	isStreaming,
	className,
}: {
	text: string;
	isStreaming: boolean;
	className?: string;
}) {
	const [manual, setManual] = useState<boolean | null>(null);
	const open = manual ?? isStreaming;

	return (
		<Collapsible
			open={open}
			// Base UI only calls this for user interaction, never for the
			// controlled changes above, so reaching here is what "toggled by
			// hand" means.
			onOpenChange={setManual}
			className={cn('flex flex-col items-start', className)}
		>
			<CollapsibleTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						className="-ml-2 gap-1.5 text-muted-foreground text-sm hover:text-foreground"
					/>
				}
			>
				<BrainIcon aria-hidden="true" />
				{isStreaming ? <Shimmer>Thinking…</Shimmer> : 'Thought process'}
				<ChevronDownIcon
					aria-hidden="true"
					className={cn(
						'transition-transform motion-reduce:transition-none',
						open && 'rotate-180',
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="h-[var(--collapsible-panel-height)] w-full overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
				<Response className="mt-1 border-l-2 pl-4 text-muted-foreground text-sm leading-6">
					{text}
				</Response>
			</CollapsibleContent>
		</Collapsible>
	);
}
