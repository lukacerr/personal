import { cn } from '@web/lib/utils';

/**
 * One turn of the conversation. The user's turns are the short ones, so they
 * read as a bubble against the right edge; the assistant's prose is the
 * content of the screen, not a reply to it, so it takes the full column with
 * no box around it. The bubble is `bg-muted` rather than `bg-primary`: in
 * this theme a primary block shouts, and a chat log full of shouting is
 * unreadable.
 */
export function Message({
	role,
	children,
	className,
}: {
	role: 'user' | 'assistant' | 'system';
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			data-role={role}
			className={cn(
				/*
				 * No font size here on purpose: the size is the reader's, set on
				 * `.agent-conversation` from their view preference. A fixed
				 * `text-[15px]` here won the specificity fight against that
				 * inherited value, so changing the preference moved the column
				 * width and nothing else. `leading-7` stays: it is unitless-ish
				 * relative to the inherited size.
				 */
				'flex w-full flex-col items-start gap-2 leading-7',
				role === 'user' && 'items-end',
				className,
			)}
		>
			{role === 'user' ? (
				<div className="max-w-[80%] rounded-xl bg-muted px-4 py-2.5">
					{children}
				</div>
			) : (
				<div
					className={cn(
						'w-full',
						// A system line is bookkeeping, not an answer: present, but
						// visibly quieter than the assistant's prose around it.
						role === 'system' && 'text-muted-foreground text-sm',
					)}
				>
					{children}
				</div>
			)}
		</div>
	);
}
