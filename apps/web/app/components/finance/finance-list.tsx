import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Card } from '@web/components/ui/card';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@web/components/ui/table';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
	formatArs,
	formatDay,
	formatMoney,
	formatMonth,
	formatUsd,
	sortPayments,
	toArs,
	toUsd,
	type UsdQuote,
} from '@web/lib/finance';
import type { Payment } from '@web/lib/finance-api';
import {
	CircleSlashIcon,
	CopyIcon,
	MoreHorizontalIcon,
	PencilIcon,
	ReceiptTextIcon,
	RepeatIcon,
	Trash2Icon,
} from 'lucide-react';
import { Fragment } from 'react';

/**
 * The row's other currency, or an honest marker when nothing can convert it.
 * Printing a converted number nobody could compute would be worse than a gap.
 */
function Converted({
	payment,
	quote,
}: {
	payment: Payment;
	quote: UsdQuote | undefined;
}) {
	const other =
		payment.currency === 'ars' ? toUsd(payment, quote) : toArs(payment, quote);

	if (other === null)
		return <span className="text-muted-foreground text-xs">no rate</span>;
	return (
		<span className="font-mono text-muted-foreground text-xs tabular-nums">
			≈ {payment.currency === 'ars' ? formatUsd(other) : formatArs(other)}
		</span>
	);
}

/** Why a subscription outside the dates is on screen, and when it stops being. */
function WindowNote({
	payment,
	from,
}: {
	payment: Payment;
	from: number | null;
}) {
	if (!payment.isSubscription) return null;
	if (payment.endedAt !== null)
		return (
			<span className="text-muted-foreground text-xs">
				ends {formatDay(payment.endedAt)}
			</span>
		);
	// With no start bound there is no "outside the period" to explain.
	if (from !== null && payment.paidAt < from)
		return (
			<span className="text-muted-foreground text-xs">
				since {formatMonth(payment.paidAt)}
			</span>
		);
	return null;
}

type RowHandlers = {
	onEdit: (payment: Payment) => void;
	onDuplicate: (payment: Payment) => void;
	onCancel: (payment: Payment) => void;
	onDelete: (payment: Payment) => void;
};

const canCancel = (payment: Payment) =>
	payment.isSubscription && payment.endedAt === null;

/**
 * On a pointer the three actions are buttons in the row: there are at most
 * three and hiding them behind a menu costs a click to reach every one. On
 * touch there is no room for three targets beside the amount, so they collapse
 * into the menu.
 */
function InlineActions({
	payment,
	onEdit,
	onDuplicate,
	onCancel,
	onDelete,
}: { payment: Payment } & RowHandlers) {
	const action = (
		label: string,
		icon: React.ReactNode,
		run: () => void,
		destructive = false,
	) => (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`${label} ${payment.title}`}
						onClick={run}
						className={destructive ? 'hover:text-destructive' : undefined}
					>
						{icon}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);

	return (
		<div className="flex items-center justify-end gap-0.5">
			{action('Edit', <PencilIcon />, () => onEdit(payment))}
			{action('Duplicate', <CopyIcon />, () => onDuplicate(payment))}
			{canCancel(payment)
				? action('Cancel subscription', <CircleSlashIcon />, () =>
						onCancel(payment),
					)
				: null}
			{action('Delete', <Trash2Icon />, () => onDelete(payment), true)}
		</div>
	);
}

function MenuActions({
	payment,
	onEdit,
	onDuplicate,
	onCancel,
	onDelete,
}: { payment: Payment } & RowHandlers) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="size-11"
						aria-label={`Actions for ${payment.title}`}
					>
						<MoreHorizontalIcon />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => onEdit(payment)}>
					<PencilIcon data-icon="inline-start" /> Edit
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onDuplicate(payment)}>
					<CopyIcon data-icon="inline-start" /> Duplicate
				</DropdownMenuItem>
				{canCancel(payment) ? (
					<DropdownMenuItem onClick={() => onCancel(payment)}>
						<CircleSlashIcon data-icon="inline-start" /> Cancel subscription
					</DropdownMenuItem>
				) : null}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					onClick={() => onDelete(payment)}
				>
					<Trash2Icon data-icon="inline-start" /> Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The list needs a name of its own. Without it the page fell straight from the
 * breakdown card into a bare table, with nothing saying the two were separate
 * sections.
 */
function ListHeading({
	count,
	recurring,
}: {
	count: number;
	recurring: number;
}) {
	return (
		<div className="flex items-baseline justify-between gap-2 pt-1">
			<h2 className="flex items-center gap-2 font-heading text-base">
				<ReceiptTextIcon
					className="size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				Payments
			</h2>
			<span className="font-mono text-muted-foreground text-xs tabular-nums">
				{count === 0
					? 'none'
					: recurring > 0
						? `${count} · ${recurring} recurring`
						: `${count}`}
			</span>
		</div>
	);
}

export function FinanceList({
	payments,
	quote,
	from,
	selectedId,
	onEdit,
	onDuplicate,
	onCancel,
	onDelete,
}: {
	payments: Payment[];
	quote: UsdQuote | undefined;
	from: number | null;
	selectedId: string | null;
} & RowHandlers) {
	if (payments.length === 0)
		return (
			<section className="flex flex-col gap-3">
				<ListHeading count={0} recurring={0} />
				<Card className="items-center gap-1 p-8 text-center">
					<p className="font-medium">Nothing in this period</p>
					<p className="text-muted-foreground text-sm">
						Add a payment, or widen the dates from the period button.
					</p>
				</Card>
			</section>
		);

	const ordered = sortPayments(payments);
	// The index the recurring block starts at, so the divider is drawn once and
	// only when both kinds are actually on screen.
	const firstSubscription = ordered.findIndex((row) => row.isSubscription);
	const showsDivider = firstSubscription > 0;

	const handlers = { onEdit, onDuplicate, onCancel, onDelete };

	const title = (payment: Payment) => (
		<div className="flex min-w-0 flex-col gap-0.5">
			<div className="flex min-w-0 items-center gap-2">
				{payment.isSubscription ? (
					<RepeatIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-label="Recurring monthly"
					/>
				) : null}
				<span className="truncate font-medium">{payment.title}</span>
				{payment.tag ? (
					<Badge variant="secondary" className="shrink-0">
						{payment.tag}
					</Badge>
				) : null}
			</div>
			<WindowNote payment={payment} from={from} />
		</div>
	);

	const amount = (payment: Payment) => (
		<div className="flex flex-col items-end">
			<span className="font-mono tabular-nums">
				{formatMoney(payment.value, payment.currency)}
			</span>
			<Converted payment={payment} quote={quote} />
		</div>
	);

	return (
		<section className="flex flex-col gap-3">
			<ListHeading
				count={ordered.length}
				recurring={
					ordered.length -
					(firstSubscription === -1 ? ordered.length : firstSubscription)
				}
			/>

			{/* Replaced rather than scrolled sideways: a horizontally scrolling table
			    inside a page that already scrolls is the worst of both. */}
			<Card size="sm" className="hidden overflow-hidden p-0 md:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Payment</TableHead>
							<TableHead className="w-28">Date</TableHead>
							<TableHead className="w-48 text-right">Amount</TableHead>
							<TableHead className="w-32" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{ordered.map((payment, index) => (
							<Fragment key={payment.id}>
								{showsDivider && index === firstSubscription ? (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={4}
											className="pt-6 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide"
										>
											<span className="flex items-center gap-2">
												<RepeatIcon className="size-3.5" aria-hidden="true" />
												Recurring monthly
											</span>
										</TableCell>
									</TableRow>
								) : null}
								<TableRow
									aria-current={payment.id === selectedId ? 'true' : undefined}
									data-state={
										payment.id === selectedId ? 'selected' : undefined
									}
								>
									<TableCell>{title(payment)}</TableCell>
									{/*
									 * A subscription's date is when it started, not when it was
									 * paid, so in a period it merely overlaps the column would be
									 * reporting something that did not happen then.
									 */}
									<TableCell className="font-mono text-muted-foreground text-sm tabular-nums">
										{payment.isSubscription ? null : formatDay(payment.paidAt)}
									</TableCell>
									<TableCell className="text-right">
										{amount(payment)}
									</TableCell>
									<TableCell>
										<InlineActions payment={payment} {...handlers} />
									</TableCell>
								</TableRow>
							</Fragment>
						))}
					</TableBody>
				</Table>
			</Card>

			<ul className="flex flex-col gap-2 md:hidden">
				{ordered.map((payment, index) => (
					<li key={payment.id}>
						{showsDivider && index === firstSubscription ? (
							<p className="flex items-center gap-2 pt-4 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
								<RepeatIcon className="size-3.5" aria-hidden="true" />
								Recurring monthly
							</p>
						) : null}
						<Card
							size="sm"
							className="flex-row items-center gap-3 p-3"
							aria-current={payment.id === selectedId ? 'true' : undefined}
						>
							<div className="min-w-0 flex-1">
								{title(payment)}
								{payment.isSubscription ? null : (
									<span className="font-mono text-muted-foreground text-xs tabular-nums">
										{formatDay(payment.paidAt)}
									</span>
								)}
							</div>
							{amount(payment)}
							<MenuActions payment={payment} {...handlers} />
						</Card>
					</li>
				))}
			</ul>
		</section>
	);
}
