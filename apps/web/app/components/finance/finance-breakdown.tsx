import { Card } from '@web/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import { formatArs, formatUsd, type TagSlice } from '@web/lib/finance';
import { TagIcon } from 'lucide-react';

/**
 * Where the money went, by tag.
 *
 * A ranked bar list rather than a pie: the question this answers is "which tag
 * cost the most", which is a ranking, and a bar reads a ranking directly while
 * a pie asks the eye to compare angles and then match them back to a legend.
 * It also means one series, so length carries the value and colour stops having
 * to tell four categories apart — the thing no five-hue palette does safely.
 *
 * Label, bar, amount and share sit on one row on purpose. Pushed to opposite
 * edges of a wide card they stop reading as a pair.
 */
export function FinanceBreakdown({
	slices,
	currency,
	selectedTags,
	onCurrencyChange,
	onToggleTag,
}: {
	slices: TagSlice[];
	currency: 'ars' | 'usd';
	selectedTags: string[];
	onCurrencyChange: (currency: 'ars' | 'usd') => void;
	onToggleTag: (label: string) => void;
}) {
	const format = currency === 'ars' ? formatArs : formatUsd;
	const total = slices.reduce((sum, slice) => sum + slice.value, 0);
	// Scaled against the leader, not the total: with one dominant tag every other
	// bar would otherwise collapse into an unreadable sliver.
	const leader = Math.max(...slices.map((slice) => slice.value), 0);
	const chosen = new Set(selectedTags.map((tag) => tag.toLocaleLowerCase()));

	return (
		<Card size="sm" className="gap-3 p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="flex items-center gap-2 font-heading text-base">
					<TagIcon
						className="size-4 text-muted-foreground"
						aria-hidden="true"
					/>
					Spending by tag
				</h2>
				<ToggleGroup
					value={[currency]}
					onValueChange={([next]) =>
						onCurrencyChange(next === 'usd' ? 'usd' : 'ars')
					}
					aria-label="Currency for the breakdown"
				>
					<ToggleGroupItem value="ars" className="min-h-11 md:min-h-8">
						ARS
					</ToggleGroupItem>
					<ToggleGroupItem value="usd" className="min-h-11 md:min-h-8">
						USD
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			<ul className="flex flex-col">
				{slices.map((slice, index) => {
					const share = total > 0 ? slice.value / total : 0;
					const active = chosen.has(slice.label.toLocaleLowerCase());
					const filterable = slice.key !== '' && slice.key !== 'other';

					return (
						<li key={slice.key}>
							<button
								type="button"
								// The bar is the filter: it replaces a dropdown nobody could
								// guess the purpose of, right where the tag is already named.
								disabled={!filterable}
								aria-pressed={filterable ? active : undefined}
								onClick={() => onToggleTag(slice.label)}
								className="group flex w-full min-h-11 items-center gap-3 rounded-md px-2 text-left transition-colors enabled:hover:bg-accent/50 disabled:cursor-default md:min-h-9"
							>
								<span
									className={`w-24 shrink-0 truncate text-sm sm:w-40 ${
										active ? 'font-medium' : ''
									}`}
								>
									{slice.label}
								</span>

								<span
									aria-hidden="true"
									className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
								>
									<span
										className="block h-full rounded-full transition-[width]"
										style={{
											width: `${leader > 0 ? (slice.value / leader) * 100 : 0}%`,
											background: `var(--chart-${Math.min(index + 1, 5)})`,
										}}
									/>
								</span>

								<span className="shrink-0 font-mono text-sm tabular-nums">
									{format(slice.value)}
								</span>
								{/* Hidden on a phone: the bar already carries the proportion,
								    and the column was squeezing it down to a sliver. */}
								<span className="hidden w-10 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums sm:block">
									{Math.round(share * 100)}%
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
