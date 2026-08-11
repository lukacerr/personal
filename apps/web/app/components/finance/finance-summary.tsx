import { Button } from '@web/components/ui/button';
import { Card } from '@web/components/ui/card';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
	type FinanceRemaining,
	type FinanceTotals,
	formatArs,
	formatUsd,
} from '@web/lib/finance';
import type { FinanceBudget } from '@web/lib/finance-settings';
import type { LiveQuote } from '@web/lib/finance-store';
import {
	ArrowDownLeftIcon,
	ArrowUpRightIcon,
	PencilIcon,
	RefreshCwIcon,
	TriangleAlertIcon,
	WalletIcon,
} from 'lucide-react';

function Stat({
	label,
	value,
	detail,
	tone,
	action,
	footer,
}: {
	label: string;
	value: string;
	detail?: string;
	tone?: 'negative';
	action?: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<Card className="gap-1 p-4">
			<div className="flex items-start justify-between gap-2">
				<span className="text-muted-foreground text-sm">{label}</span>
				{action}
			</div>
			<span
				className={`font-mono text-3xl tabular-nums ${
					tone === 'negative' ? 'text-destructive' : ''
				}`}
			>
				{value}
			</span>
			{/*
			 * Reserved even when empty, and clipped rather than wrapped, so the four
			 * cards keep a common baseline whatever ends up in here.
			 */}
			<span
				title={detail}
				className="min-h-5 truncate font-mono text-muted-foreground text-xs tabular-nums"
			>
				{detail}
			</span>
			{footer}
		</Card>
	);
}

/**
 * The official quote, given a card of its own.
 *
 * It is two numbers that are easy to mistake for one range, so each is labelled
 * by the direction it is used in rather than by its name: buying dollars is
 * what a dollar expense costs, selling them is what pays a peso one.
 */
function QuoteCard({
	quote,
	failed,
	onRefresh,
}: {
	quote: LiveQuote | undefined;
	failed: boolean;
	onRefresh: () => void;
}) {
	const side = (
		icon: React.ReactNode,
		label: string,
		value: number | undefined,
	) => (
		<div className="flex items-baseline gap-2">
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				{icon}
				{label}
			</span>
			<span className="font-mono text-xl tabular-nums">{value ?? '—'}</span>
		</div>
	);

	const age = quote
		? Math.round((Date.now() - quote.fetchedAt) / 60_000)
		: undefined;

	return (
		<Card className="gap-1 p-4">
			<div className="flex items-start justify-between gap-2">
				<span className="text-muted-foreground text-sm">USD rate</span>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="size-11 md:size-8"
								onClick={onRefresh}
								aria-label="Refresh the official quote"
							>
								<RefreshCwIcon />
							</Button>
						}
					/>
					<TooltipContent>
						A dollar expense costs the buy rate in pesos because you buy those
						dollars; a peso expense divides by the sell rate because you sell
						them. Click to refresh.
					</TooltipContent>
				</Tooltip>
			</div>

			<div className="flex flex-col gap-0.5">
				{side(
					<ArrowUpRightIcon className="size-3.5" aria-hidden="true" />,
					'buy',
					quote?.venta,
				)}
				{side(
					<ArrowDownLeftIcon className="size-3.5" aria-hidden="true" />,
					'sell',
					quote?.compra,
				)}
			</div>

			<span className="min-h-5 truncate font-mono text-muted-foreground text-xs tabular-nums">
				{quote ? (
					quote.stale ? (
						'last one known'
					) : age !== undefined && age < 1 ? (
						'just now'
					) : (
						`${age}m ago`
					)
				) : (
					<span className="flex items-center gap-1 text-destructive">
						<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
						{failed ? 'unavailable' : 'reading…'}
					</span>
				)}
			</span>
		</Card>
	);
}

export function FinanceSummary({
	totals,
	budget,
	remaining,
	quote,
	quoteFailed,
	onEditBudget,
	onRefreshQuote,
}: {
	totals: FinanceTotals;
	budget: FinanceBudget | undefined;
	remaining: FinanceRemaining | undefined;
	quote: LiveQuote | undefined;
	quoteFailed: boolean;
	onEditBudget: () => void;
	onRefreshQuote: () => void;
}) {
	/** No currency symbol: the card it sits under already named the currency. */
	const plain = (value: number) => formatArs(value).replace(/^\$\s*/, '');

	const counted = `${totals.count} ${totals.count === 1 ? 'payment' : 'payments'}${
		totals.subscriptions > 0 ? ` · ${totals.subscriptions} recurring` : ''
	}`;

	/**
	 * Rows no quote could convert are named rather than folded in as zero: a
	 * total that quietly omits two expenses is worse than one that says so.
	 */
	const missing =
		totals.unconvertible > 0
			? `${totals.unconvertible} without a rate`
			: totals.approximate > 0
				? `${totals.approximate} at today's rate`
				: undefined;

	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			{/*
			 * The split belongs to the number it breaks down. Currency symbols are
			 * dropped because the card's own label already said pesos, and with them
			 * the line wraps and breaks the card baseline.
			 */}
			<Stat
				label="Total in pesos"
				value={formatArs(totals.ars)}
				detail={
					totals.recurringArs > 0 && totals.oneOffArs > 0
						? `${plain(totals.recurringArs)} fixed · ${plain(totals.oneOffArs)} one-off`
						: counted
				}
			/>
			<Stat
				label="Total in dollars"
				value={formatUsd(totals.usd)}
				detail={missing ?? counted}
			/>

			{/*
			 * The budget lives inside the card it produces rather than in one of its
			 * own: it is set once and then only read as the thing "left over" is
			 * measured against.
			 */}
			<Stat
				label="Left over"
				value={
					remaining?.ars === null || remaining === undefined
						? '—'
						: formatArs(remaining.ars)
				}
				// Overspending is the number worth seeing, so it is never clamped.
				tone={
					remaining?.ars !== null && (remaining?.ars ?? 0) < 0
						? 'negative'
						: undefined
				}
				detail={
					remaining?.usd === null || remaining === undefined
						? undefined
						: formatUsd(remaining.usd)
				}
				footer={
					<button
						type="button"
						onClick={onEditBudget}
						className="-mx-1 mt-1 flex min-h-11 items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/50 hover:text-foreground md:min-h-8"
					>
						<WalletIcon className="size-3.5 shrink-0" aria-hidden="true" />
						{budget ? (
							<>
								<span>Budget</span>
								<span className="font-mono tabular-nums">
									{budget.currency === 'ars'
										? formatArs(budget.amount)
										: formatUsd(budget.amount)}
								</span>
							</>
						) : (
							<span>Set a budget</span>
						)}
						<PencilIcon
							className="size-3 shrink-0 opacity-60"
							aria-hidden="true"
						/>
					</button>
				}
			/>

			<QuoteCard
				quote={quote}
				failed={quoteFailed}
				onRefresh={onRefreshQuote}
			/>
		</div>
	);
}
