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
import { useLayoutEffect, useRef } from 'react';

/**
 * One correction step for a figure against the width it actually rendered at.
 * The cqi sizing already answers to the card, but a system font scale (the
 * WebView's text zoom) multiplies whatever font the stylesheet computes
 * without growing the card, and no coefficient can see that multiplier — only
 * a measurement of the overflow can. Below the floor the ellipsis takes over:
 * a figure too small to read is worse than one that says it was cut.
 */
export function fittedScale(
	scale: number,
	scrollWidth: number,
	clientWidth: number,
) {
	if (clientWidth <= 0 || scrollWidth <= clientWidth) return scale;
	return Math.max(0.4, scale * (clientWidth / scrollWidth));
}

function useFittedFigure(value: string) {
	const ref = useRef<HTMLSpanElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(value): the effect measures the text that just rendered, so a new figure needs a fresh measurement even though it only reads the DOM
	useLayoutEffect(() => {
		const span = ref.current;
		if (!span) return;

		// Fractional, unlike `scrollWidth`: the fit converges onto the exact
		// boundary, where an integer measurement rounds a sub-pixel overflow
		// away and the ellipsis still swallows a digit.
		const textWidth = () => {
			const range = span.ownerDocument.createRange();
			range.selectNodeContents(span);
			return range.getBoundingClientRect().width;
		};

		const refit = () => {
			span.style.fontSize = '';
			const base = Number.parseFloat(window.getComputedStyle(span).fontSize);
			if (!Number.isFinite(base) || base <= 0) return;
			let scale = 1;
			// More than one pass, because the same text zoom that outgrew the
			// stylesheet scales what gets set here too, so a correction can land
			// short by that factor. The pixel of slack keeps the fit off the
			// exact boundary the ellipsis triggers on.
			for (let pass = 0; pass < 3; pass += 1) {
				const next = fittedScale(scale, textWidth(), span.clientWidth - 1);
				if (next === scale) break;
				scale = next;
				span.style.fontSize = `${base * scale}px`;
			}
		};

		refit();
		// A font swap changes the text's width without changing the span's box,
		// so the resize observer alone would sleep through it.
		document.fonts?.ready.then(refit).catch(() => {});
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(refit);
		observer.observe(span);
		return () => observer.disconnect();
	}, [value]);

	return ref;
}

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
	const figure = useFittedFigure(value);
	return (
		// Its own container, so the figure below can be sized against this card
		// rather than against the row all four share.
		<Card className="@container gap-1 p-4">
			<div className="flex items-start justify-between gap-2">
				<span className="text-muted-foreground text-sm">{label}</span>
				{action}
			</div>
			{/*
			 * Sized against the card and not against a breakpoint. Every split halves
			 * the room a figure has, and the card's width is not a function of the
			 * window: the sidebar is resizable and collapsible, and a system font
			 * scale grows the text without growing the card at all. Three fixed tiers
			 * had been wrong on three devices before this — a 1080px portrait monitor,
			 * a 360px phone, and a flip cover screen.
			 *
			 * `cqi` is 1% of this card's inline size, so the coefficient is just how
			 * many characters have to fit: 10 holds a 13-character total at every
			 * card width the grid produces, measured. The `min` keeps a wide card from
			 * growing the figure past what the design asked for.
			 *
			 * `truncate` stays as the floor under all of it: the card clips with
			 * `overflow-hidden`, and a total quietly reading 1.526.34 is a different
			 * number with nothing to show it was cut.
			 *
			 * The ref measures the rendered overflow and shrinks the figure to fit,
			 * because a system text zoom multiplies this font — cqi, rem and all —
			 * without growing the card, which is invisible to the stylesheet.
			 */}
			<span
				ref={figure}
				title={value}
				className={`truncate font-mono text-[min(1.875rem,10cqi)] tabular-nums ${
					tone === 'negative' ? 'text-destructive' : ''
				}`}
			>
				{value}
			</span>
			{/*
			 * Reserved even when empty, and clipped rather than wrapped, so the four
			 * cards keep a common baseline whatever ends up in here. Anything a card
			 * wants to act on shares this line rather than opening one of its own:
			 * the cards sit in a grid row, so a single extra line under one of them
			 * is height charged to all four.
			 */}
			<div className="flex min-h-6 flex-wrap items-center gap-x-2 overflow-hidden">
				<span
					title={detail}
					className="truncate font-mono text-muted-foreground text-xs tabular-nums"
				>
					{detail}
				</span>
				{footer}
			</div>
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
			<span className="font-mono text-xl tabular-nums @xs/summary:text-base @md/summary:text-lg @6xl/summary:text-xl">
				{value ?? '—'}
			</span>
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

			{/*
			 * Side by side rather than stacked: the two rates are the shortest thing
			 * on the row and stacking them spent height to leave most of the card
			 * empty. It wraps instead of picking a breakpoint, so a card too narrow
			 * for both falls back to the stack on its own.
			 */}
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
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

			{/* Same reserved line as the other three, so the row shares a baseline.
			    The age is computed once per render and then sits still, so the
			    absolute time rides along in the title as the honest fallback. */}
			<span
				title={quote ? new Date(quote.fetchedAt).toLocaleString() : undefined}
				className="flex min-h-6 items-center truncate font-mono text-muted-foreground text-xs tabular-nums"
			>
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
		/*
		 * Queried against this wrapper rather than the viewport: the sidebar is
		 * collapsible and resizable between 224 and 384px, so the same window can
		 * hand this row anything from ~660 to ~1060px. Viewport breakpoints guessed
		 * that wrong in both directions — four columns at a 1080px window clipped a
		 * peso total whenever the sidebar was open, and two columns left ~490px
		 * cards holding ~200px of content whenever it was closed.
		 */
		<div className="@container/summary">
			{/*
			 * Two up from a phone, because one card per row spent the width on nothing
			 * and pushed the breakdown a full screen down. Four from 60rem rather than
			 * the `@4xl` next to it: four columns need ~200px of content each to hold
			 * a total, and at 56rem they get 183. It has to stay under `@5xl` too, or
			 * a 1080px window with the sidebar closed — 1014px here — would fall back
			 * to two columns, which is the case that started all of this.
			 *
			 * The single column survives for anything narrower than 20rem, where the
			 * halves are too tight for a total at any size worth reading.
			 */}
			<div className="grid gap-3 @xs/summary:grid-cols-2 @min-[60rem]/summary:grid-cols-4">
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
						/*
						 * Generous to touch while a card is on a row of its own, and only
						 * as tall as the line it shares once several sit on a desktop row —
						 * still the 24px a pointer target needs, without charging the other
						 * three cards for it. The word goes as soon as the cards are side
						 * by side at all: from there the room is for the figure or for the
						 * label, and the figure is the one being read.
						 *
						 * It never shrinks, so the line wraps instead when both will not
						 * fit. A phone's two-up is exactly that case, and a budget cut off
						 * mid-figure would be a number reading something it is not.
						 */
						<button
							type="button"
							onClick={onEditBudget}
							aria-label={budget ? 'Edit the budget' : 'Set a budget'}
							className="-mx-1 flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/50 hover:text-foreground @md/summary:min-h-6"
						>
							<WalletIcon className="size-3.5 shrink-0" aria-hidden="true" />
							{budget ? (
								<>
									<span className="@xs/summary:hidden">Budget</span>
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
		</div>
	);
}
