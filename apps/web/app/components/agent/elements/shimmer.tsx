import { cn } from '@web/lib/utils';

/**
 * The "still thinking" label: a gradient clipped to the glyphs, pulsed by the
 * stock `animate-pulse` keyframe. A travelling background-position sweep would
 * need a global `@keyframes`, and this system's only claim on app.css is its
 * `@source` lines — the pulse reads as the same "alive, not stuck" signal
 * without new global CSS. With reduced motion the text simply sits still in
 * `text-muted-foreground`.
 */
export function Shimmer({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				'animate-pulse bg-clip-text bg-linear-to-r from-muted-foreground via-foreground to-muted-foreground text-transparent',
				'motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground',
				className,
			)}
		>
			{children}
		</span>
	);
}
