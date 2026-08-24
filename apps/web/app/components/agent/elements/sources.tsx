import { Button } from '@web/components/ui/button';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import { cn } from '@web/lib/utils';
import { BookIcon, ChevronDownIcon, ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';

/** The part of the link a reader judges trust by; null when it has none. */
function hostnameOf(url: string) {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/**
 * The citations behind an answer, folded to a count until asked for. Every
 * link leaves the app, so each opens in a new tab and shows its hostname —
 * the title is the model's words, the hostname is the link's.
 */
export function Sources({
	sources,
	className,
}: {
	sources: { title: string; url: string }[];
	className?: string;
}) {
	const [open, setOpen] = useState(false);

	if (sources.length === 0) return null;

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
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
				<BookIcon aria-hidden="true" />
				{sources.length} {sources.length === 1 ? 'source' : 'sources'}
				<ChevronDownIcon
					aria-hidden="true"
					className={cn(
						'transition-transform motion-reduce:transition-none',
						open && 'rotate-180',
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="h-[var(--collapsible-panel-height)] w-full overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
				<ul className="flex flex-col gap-0.5 pt-1">
					{sources.map((source) => {
						const hostname = hostnameOf(source.url);
						return (
							<li key={source.url}>
								<a
									href={source.url}
									target="_blank"
									rel="noreferrer"
									className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-sm hover:bg-muted"
								>
									<ExternalLinkIcon
										aria-hidden="true"
										className="size-3.5 shrink-0 text-muted-foreground"
									/>
									<span className="truncate underline-offset-4 hover:underline">
										{source.title}
									</span>
									{hostname && (
										<span className="shrink-0 text-muted-foreground text-xs">
											{hostname}
										</span>
									)}
								</a>
							</li>
						);
					})}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}
