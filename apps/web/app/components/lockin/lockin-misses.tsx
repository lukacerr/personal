import { KPI_ICONS } from '@web/components/lockin/lockin-verdict';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Card } from '@web/components/ui/card';
import { formatDay, KPI_LABELS, type LockinMiss } from '@web/lib/lockin';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';

/** Enough to see the latest pattern; the rest is one click away. Even, for two columns. */
const COLLAPSED = 6;

/** What went wrong, newest first, each with how far off it was. */
export function LockinMisses({ misses }: { misses: LockinMiss[] }) {
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? misses : misses.slice(0, COLLAPSED);

	return (
		<section
			aria-labelledby="lockin-misses"
			className="@container flex flex-col gap-3"
		>
			<h2
				id="lockin-misses"
				className="flex items-baseline gap-2 font-heading font-semibold text-lg"
			>
				What went wrong
				{misses.length > 0 ? (
					<span className="font-mono font-normal text-muted-foreground text-sm tabular-nums">
						{misses.length}
					</span>
				) : null}
			</h2>
			<Card size="sm" className="gap-0 px-4 py-2 sm:px-6">
				{misses.length === 0 ? (
					<p className="flex items-center gap-2 py-4 text-sm">
						<CheckIcon
							aria-hidden
							className="size-4 text-success"
							strokeWidth={3}
						/>
						Nothing so far.
					</p>
				) : (
					<>
						{/* Two columns when wide: a row stretched across the page stops reading as one. */}
						<ul className="grid @3xl:grid-cols-2 @3xl:gap-x-10">
							{shown.map((miss) => {
								const Icon = KPI_ICONS[miss.kpi];
								return (
									<li
										key={`${miss.date}-${miss.kpi}-${miss.week ?? 'day'}`}
										className="flex items-center gap-3 border-t py-2.5 first:border-t-0 @3xl:[&:nth-child(2)]:border-t-0"
									>
										<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
											<Icon aria-hidden className="size-4" />
										</span>
										<div className="flex min-w-0 flex-1 flex-col">
											<span className="flex items-center gap-2 font-medium">
												{KPI_LABELS[miss.kpi]}
												{miss.week ? (
													<Badge variant="outline">Week {miss.week}</Badge>
												) : null}
											</span>
											<span className="truncate font-mono text-muted-foreground text-xs tabular-nums">
												{miss.detail}
											</span>
										</div>
										<span className="shrink-0 text-muted-foreground text-xs">
											{formatDay(miss.date)}
										</span>
									</li>
								);
							})}
						</ul>
						{misses.length > COLLAPSED ? (
							<Button
								variant="ghost"
								className="my-1 self-center"
								onClick={() => setExpanded((open) => !open)}
							>
								{expanded ? 'Show less' : `Show all ${misses.length}`}
							</Button>
						) : null}
					</>
				)}
			</Card>
		</section>
	);
}
