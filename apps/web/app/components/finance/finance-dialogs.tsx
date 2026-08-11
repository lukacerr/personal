import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import { formatLocalDate, parseAmount } from '@web/lib/finance';
import type { Payment, PaymentDraft } from '@web/lib/finance-api';
import type { FinanceBudget } from '@web/lib/finance-settings';
import { useEffect, useId, useState } from 'react';

export type PaymentFormTarget =
	/** `from` seeds the fields from an existing payment without editing it. */
	{ kind: 'create'; from?: Payment } | { kind: 'edit'; payment: Payment };

const localDateToMs = (value: string) => {
	const [year, month, date] = value.split('-').map(Number);
	return new Date(year, month - 1, date).getTime();
};

/**
 * Creating and editing a payment.
 *
 * One dialog for both, and one validation path with it: the same rules have to
 * hold from either entry point, so there is nowhere for the two to drift apart.
 */
export function PaymentFormDialog({
	target,
	tags,
	busy,
	error,
	onSubmit,
	onClose,
}: {
	target: PaymentFormTarget | undefined;
	tags: string[];
	busy: boolean;
	/** Stays inside the dialog: a rejected save is a condition, not a notice. */
	error: string | undefined;
	onSubmit: (draft: PaymentDraft) => void;
	onClose: () => void;
}) {
	// Explicit ids rather than wrapping the input: `Input` is a component, so a
	// wrapping label associates with nothing that a screen reader can follow.
	const listId = useId();
	const titleId = useId();
	const amountId = useId();
	const tagId = useId();
	const paidAtId = useId();
	const recurringId = useId();
	const editing = target?.kind === 'edit' ? target.payment : undefined;

	const [title, setTitle] = useState('');
	const [amount, setAmount] = useState('');
	const [tag, setTag] = useState('');
	const [currency, setCurrency] = useState<'ars' | 'usd'>('ars');
	const [isSubscription, setIsSubscription] = useState(false);
	const [paidAt, setPaidAt] = useState(() => formatLocalDate(Date.now()));
	const [invalid, setInvalid] = useState<string>();

	// Keyed on the target's identity, not its contents: the parent builds a fresh
	// one each time the dialog opens, so reopening the same payment still clears
	// whatever was typed into it last time.
	useEffect(() => {
		const seed = target?.kind === 'edit' ? target.payment : target?.from;
		setTitle(seed?.title ?? '');
		setAmount(seed ? String(seed.value) : '');
		setTag(seed?.tag ?? '');
		setCurrency(seed?.currency ?? 'ars');
		setIsSubscription(seed?.isSubscription ?? false);
		// A duplicate is a new expense happening now, not a copy of an old date.
		setPaidAt(
			formatLocalDate(
				target?.kind === 'edit' ? target.payment.paidAt : Date.now(),
			),
		);
		setInvalid(undefined);
	}, [target]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const trimmed = title.trim();
		if (!trimmed) {
			setInvalid('Give the payment a title.');
			return;
		}
		const value = parseAmount(amount);
		if (value === undefined) {
			setInvalid('Enter an amount greater than zero.');
			return;
		}

		setInvalid(undefined);
		onSubmit({
			title: trimmed,
			tag: tag.trim() || null,
			value,
			currency,
			isSubscription,
			paidAt: localDateToMs(paidAt),
			// Editing never reopens a closed window by accident, and a duplicate
			// always starts open: cancelling is its own action either way.
			endedAt: editing?.endedAt ?? null,
		});
	}

	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>
							{target?.kind === 'edit'
								? 'Edit payment'
								: target?.from
									? `Duplicate “${target.from.title}”`
									: 'Add payment'}
						</DialogTitle>
						<DialogDescription>
							The date is when the expense happened, which is what decides the
							period it lands in.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-1.5 text-sm">
						<label htmlFor={titleId}>Title</label>
						<Input
							id={titleId}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Alquiler"
							autoFocus
						/>
					</div>

					<div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-end sm:gap-2">
						<div className="flex flex-1 flex-col gap-1.5">
							<label htmlFor={amountId}>Amount</label>
							{/*
							 * Text with a decimal keypad rather than `type="number"`: on
							 * Android the numeric keyboard offers a separator that does not
							 * match the locale, so both `1.234,56` and `1234.56` have to work.
							 */}
							<Input
								id={amountId}
								value={amount}
								inputMode="decimal"
								onChange={(event) => setAmount(event.target.value)}
								placeholder="508075"
							/>
						</div>
						<ToggleGroup
							value={[currency]}
							onValueChange={([next]) =>
								setCurrency(next === 'usd' ? 'usd' : 'ars')
							}
							aria-label="Currency"
						>
							<ToggleGroupItem value="ars">ARS</ToggleGroupItem>
							<ToggleGroupItem value="usd">USD</ToggleGroupItem>
						</ToggleGroup>
					</div>

					<div className="flex flex-col gap-4 sm:flex-row">
						<div className="flex flex-1 flex-col gap-1.5 text-sm">
							<label htmlFor={tagId}>Tag</label>
							{/* A native datalist, which is what keeps "Comida" and "comida"
							    from becoming two slices in practice. */}
							<Input
								id={tagId}
								value={tag}
								list={listId}
								onChange={(event) => setTag(event.target.value)}
								placeholder="Servicios"
							/>
							<datalist id={listId}>
								{tags.map((option) => (
									<option key={option} value={option} />
								))}
							</datalist>
						</div>

						<div className="flex flex-1 flex-col gap-1.5 text-sm">
							<label htmlFor={paidAtId}>Paid on</label>
							<Input
								id={paidAtId}
								type="date"
								value={paidAt}
								onChange={(event) => setPaidAt(event.target.value)}
							/>
						</div>
					</div>

					<div className="flex items-center gap-2 text-sm">
						<Checkbox
							id={recurringId}
							checked={isSubscription}
							onCheckedChange={(checked) => setIsSubscription(checked === true)}
						/>
						<label htmlFor={recurringId}>Recurring monthly</label>
					</div>
					{isSubscription ? (
						<p className="-mt-2 text-muted-foreground text-xs">
							Counts in every period from this date on, and converts at today's
							rate because you pay it again each month.
						</p>
					) : null}

					{invalid || error ? (
						<p role="alert" className="text-destructive text-sm">
							{invalid ?? error}
						</p>
					) : null}

					<DialogFooter>
						<DialogClose
							render={
								<Button type="button" variant="outline">
									Cancel
								</Button>
							}
						/>
						<Button type="submit" disabled={busy}>
							{busy ? <Spinner /> : null}
							{editing ? 'Save' : 'Add payment'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function PaymentDeleteDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target: Payment | undefined;
	busy: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete this payment?</DialogTitle>
					<DialogDescription>
						{target?.isSubscription
							? `"${target.title}" is recurring, so deleting it removes it from every past period too. Cancel it instead to keep the history.`
							: `"${target?.title}" will be gone for good.`}
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Keep it</Button>} />
					<Button variant="destructive" disabled={busy} onClick={onConfirm}>
						{busy ? <Spinner /> : null} Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Cancelling writes an end date rather than deleting the row, so every period
 * that already paid for it keeps counting it.
 */
export function SubscriptionCancelDialog({
	target,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	target: Payment | undefined;
	busy: boolean;
	error: string | undefined;
	onConfirm: (endedAt: number) => void;
	onClose: () => void;
}) {
	const endedAtId = useId();
	const [endedAt, setEndedAt] = useState(() => formatLocalDate(Date.now()));

	// Today, unless the subscription has not started yet — an end date before the
	// start is the one thing the API refuses, so the default never proposes one.
	useEffect(() => {
		if (!target) return;
		setEndedAt(formatLocalDate(Math.max(Date.now(), target.paidAt)));
	}, [target]);

	const invalid =
		target !== undefined && localDateToMs(endedAt) < target.paidAt;

	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Cancel “{target?.title}”?</DialogTitle>
					<DialogDescription>
						It stops counting from this date on. Periods before it keep it,
						which is what deleting would take away.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-1.5 text-sm">
					<label htmlFor={endedAtId}>Last day it applies</label>
					<Input
						id={endedAtId}
						type="date"
						value={endedAt}
						onChange={(event) => setEndedAt(event.target.value)}
					/>
				</div>

				{invalid ? (
					<p role="alert" className="text-destructive text-sm">
						It cannot end before it started.
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}

				<DialogFooter>
					<DialogClose render={<Button variant="outline">Keep it</Button>} />
					<Button
						disabled={busy || invalid}
						onClick={() => onConfirm(localDateToMs(endedAt))}
					>
						{busy ? <Spinner /> : null} Cancel subscription
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function BudgetDialog({
	open,
	budget,
	onSave,
	onClose,
}: {
	open: boolean;
	budget: FinanceBudget | undefined;
	onSave: (budget: FinanceBudget | undefined) => void;
	onClose: () => void;
}) {
	const amountId = useId();
	const [amount, setAmount] = useState('');
	const [currency, setCurrency] = useState<'ars' | 'usd'>('ars');
	const [invalid, setInvalid] = useState<string>();

	// Reset on opening, not on every change to `budget`: otherwise typing a
	// figure, cancelling and reopening would show the abandoned one back.
	useEffect(() => {
		if (!open) return;
		setAmount(budget ? String(budget.amount) : '');
		setCurrency(budget?.currency ?? 'ars');
		setInvalid(undefined);
	}, [budget, open]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = parseAmount(amount);
		if (value === undefined) {
			setInvalid('Enter an amount greater than zero.');
			return;
		}
		onSave({ amount: value, currency });
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Budget</DialogTitle>
						<DialogDescription>
							What the period is measured against. Kept in this browser only.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-end sm:gap-2">
						<div className="flex flex-1 flex-col gap-1.5">
							<label htmlFor={amountId}>Amount</label>
							<Input
								id={amountId}
								value={amount}
								inputMode="decimal"
								onChange={(event) => setAmount(event.target.value)}
								placeholder="3000000"
								autoFocus
							/>
						</div>
						<ToggleGroup
							value={[currency]}
							onValueChange={([next]) =>
								setCurrency(next === 'usd' ? 'usd' : 'ars')
							}
							aria-label="Budget currency"
						>
							<ToggleGroupItem value="ars">ARS</ToggleGroupItem>
							<ToggleGroupItem value="usd">USD</ToggleGroupItem>
						</ToggleGroup>
					</div>

					{invalid ? (
						<p role="alert" className="text-destructive text-sm">
							{invalid}
						</p>
					) : null}

					<DialogFooter>
						{budget ? (
							<Button
								type="button"
								variant="outline"
								onClick={() => onSave(undefined)}
							>
								Clear
							</Button>
						) : null}
						<DialogClose
							render={
								<Button type="button" variant="outline">
									Cancel
								</Button>
							}
						/>
						<Button type="submit">Save</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
