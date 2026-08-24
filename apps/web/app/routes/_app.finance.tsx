import { FinanceBreakdown } from '@web/components/finance/finance-breakdown';
import {
	BudgetDialog,
	PaymentDeleteDialog,
	PaymentFormDialog,
	type PaymentFormTarget,
	SubscriptionCancelDialog,
} from '@web/components/finance/finance-dialogs';
import { FinanceList } from '@web/components/finance/finance-list';
import { FinanceSummary } from '@web/components/finance/finance-summary';
import { FinanceToolbar } from '@web/components/finance/finance-toolbar';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import { useConsumeCreateParam } from '@web/lib/create-param';
import {
	collectTags,
	currentMonthRange,
	type DateRange,
	filterPayments,
	financeTotals,
	isAddPaymentShortcut,
	parseFinanceView,
	remainingFor,
	tagBreakdown,
	updateFinanceSearchParams,
} from '@web/lib/finance';
import {
	type Payment,
	type PaymentDraft,
	readSharedSettings,
	writeSharedSettings,
} from '@web/lib/finance-api';
import {
	DEFAULT_FINANCE_SETTINGS,
	type FinanceBudget,
	type FinanceSettings,
	loadFinanceSettings,
	reconcileFinanceSettings,
	saveFinanceSettings,
} from '@web/lib/finance-settings';
import { useFinanceStore } from '@web/lib/finance-store';
import { indexUnavailable } from '@web/lib/index-store';
import {
	type SharedSettingsAdapter,
	useSharedSettings,
} from '@web/lib/shared-settings';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

export function meta() {
	return [{ title: 'Finance · Personal' }];
}

/** Module-level so the hook's one-shot reconciliation stays one-shot. */
const settingsAdapter: SharedSettingsAdapter<FinanceSettings> = {
	defaults: DEFAULT_FINANCE_SETTINGS,
	loadLocal: () => loadFinanceSettings(window.localStorage),
	saveLocal: (settings) => saveFinanceSettings(window.localStorage, settings),
	readShared: readSharedSettings,
	writeShared: writeSharedSettings,
	reconcile: reconcileFinanceSettings,
};

export default function Finance() {
	const [searchParams, setSearchParams] = useSearchParams();

	// Adopt the shared budget and range, or seed them from this device; every
	// later change writes the local mirror first and reports a failed share.
	const { settings, patchSettings } = useSharedSettings(settingsAdapter);

	// Read once per mount rather than per filter: a fresh `Date.now()` in
	// three places could straddle midnight.
	const now = useMemo(() => Date.now(), []);
	// The url wins when it carries a range; otherwise the one last picked here,
	// and only a browser that has never picked one falls to the current month.
	// Memoized, or every keystroke of the search box would re-filter the whole
	// index through a fresh view object.
	const view = useMemo(
		() =>
			parseFinanceView(searchParams, settings.range ?? currentMonthRange(now)),
		[searchParams, settings.range, now],
	);

	const [queryInput, setQueryInput] = useState(view.query);
	const [chartCurrency, setChartCurrency] = useState<'ars' | 'usd'>('ars');
	const [form, setForm] = useState<PaymentFormTarget>();
	const [formError, setFormError] = useState<string>();
	const [deleting, setDeleting] = useState<Payment>();
	const [cancelling, setCancelling] = useState<Payment>();
	const [dialogError, setDialogError] = useState<string>();
	const [dialogBusy, setDialogBusy] = useState(false);
	const [editingBudget, setEditingBudget] = useState(false);

	const {
		payments,
		status,
		error,
		quote,
		quoteFailed,
		load,
		loadQuote,
		record,
		revise,
		discard,
	} = useFinanceStore();

	useEffect(() => {
		void load();
		void loadQuote();
	}, [load, loadQuote]);

	useEffect(() => {
		setQueryInput(view.query);
	}, [view.query]);

	// "Add payment" from the palette arrives as `?new=1` and opens the dialog.
	useConsumeCreateParam(
		useCallback(() => {
			setFormError(undefined);
			setForm({ kind: 'create' });
		}, []),
	);

	/**
	 * The bare letter that opens the form. Any dialog already being open is a
	 * skip rather than something the predicate could know: focus inside one often
	 * rests on a button rather than a field, so the editable check alone would let
	 * the key discard an edit halfway through and reopen the form over it.
	 */
	const dialogOpen =
		form !== undefined ||
		deleting !== undefined ||
		cancelling !== undefined ||
		editingBudget;

	useEffect(() => {
		if (dialogOpen) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || !isAddPaymentShortcut(event)) return;
			event.preventDefault();
			setFormError(undefined);
			setForm({ kind: 'create' });
		}

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [dialogOpen]);

	// Debounced so typing does not write a history entry per keystroke, and
	// `replace` so back still leaves the screen rather than unwinding the search.
	useEffect(() => {
		if (queryInput === view.query) return;
		const timeout = window.setTimeout(() => {
			setSearchParams(
				(current) => updateFinanceSearchParams(current, { query: queryInput }),
				{ replace: true },
			);
		}, 150);
		return () => window.clearTimeout(timeout);
	}, [queryInput, setSearchParams, view.query]);

	const visible = useMemo(
		() => filterPayments(payments, view),
		[payments, view],
	);
	const totals = useMemo(() => financeTotals(visible, quote), [visible, quote]);
	const slices = useMemo(
		() => tagBreakdown(visible, quote, chartCurrency),
		[visible, quote, chartCurrency],
	);
	const tags = useMemo(() => collectTags(payments), [payments]);
	const remaining = remainingFor(settings.budget, totals, quote);

	// Written to the url so the view stays shareable, and remembered so opening
	// Finance from the sidebar lands on the same period rather than resetting.
	function setRange(range: DateRange) {
		patchSettings({ range });
		setSearchParams(
			(current) => updateFinanceSearchParams(current, { range }),
			{ replace: true },
		);
	}

	function setTags(tags: string[]) {
		setSearchParams((current) => updateFinanceSearchParams(current, { tags }), {
			replace: true,
		});
	}

	/** Filtering happens from the breakdown rows, where the tag is already named. */
	function toggleTag(label: string) {
		const key = label.toLocaleLowerCase();
		setTags(
			view.tags.some((tag) => tag.toLocaleLowerCase() === key)
				? view.tags.filter((tag) => tag.toLocaleLowerCase() !== key)
				: [...view.tags, label],
		);
	}

	async function submitForm(draft: PaymentDraft) {
		setDialogBusy(true);
		const failure =
			form?.kind === 'edit'
				? await revise(form.payment.id, draft)
				: await record(draft);
		setDialogBusy(false);

		if (failure) {
			setFormError(failure);
			return;
		}
		setForm(undefined);
	}

	async function confirmDelete() {
		if (!deleting) return;
		setDialogBusy(true);
		const failure = await discard(deleting.id);
		setDialogBusy(false);

		if (failure) {
			setDialogError(failure);
			return;
		}
		setDeleting(undefined);
	}

	async function confirmCancel(endedAt: number) {
		if (!cancelling) return;
		setDialogBusy(true);
		const failure = await revise(cancelling.id, { endedAt });
		setDialogBusy(false);

		if (failure) {
			setDialogError(failure);
			return;
		}
		setCancelling(undefined);
		toast.success(`${cancelling.title} stops counting after that date.`);
	}

	return (
		<section
			aria-label="Payments"
			className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6"
		>
			<FinanceToolbar
				query={queryInput}
				range={view}
				selectedTags={view.tags}
				subscriptions={view.subscriptions}
				refreshing={status === 'loading'}
				onRefresh={() => {
					void load(true);
					void loadQuote(true);
				}}
				onQueryChange={setQueryInput}
				onRangeChange={setRange}
				onClearTags={() => setTags([])}
				onSubscriptionsChange={(on) =>
					setSearchParams(
						(current) =>
							updateFinanceSearchParams(current, { subscriptions: on }),
						{ replace: true },
					)
				}
				onCreate={() => {
					setFormError(undefined);
					setForm({ kind: 'create' });
				}}
			/>

			{status === 'loading' && payments.length === 0 ? (
				<div className="flex flex-1 items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
					<Spinner /> Loading payments…
				</div>
			) : indexUnavailable(status) && payments.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
					<p className="font-medium">{error}</p>
					<Button variant="outline" onClick={() => void load(true)}>
						Try again
					</Button>
				</div>
			) : (
				<>
					{indexUnavailable(status) && error ? (
						<div
							role="alert"
							className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
						>
							<p>{error}</p>
							<Button
								size="sm"
								variant="outline"
								onClick={() => void load(true)}
							>
								Try again
							</Button>
						</div>
					) : null}
					<FinanceSummary
						totals={totals}
						budget={settings.budget}
						remaining={remaining}
						quote={quote}
						quoteFailed={quoteFailed}
						onEditBudget={() => setEditingBudget(true)}
						onRefreshQuote={() => void loadQuote(true)}
					/>

					{slices.length > 0 ? (
						<FinanceBreakdown
							slices={slices}
							currency={chartCurrency}
							selectedTags={view.tags}
							onCurrencyChange={setChartCurrency}
							onToggleTag={toggleTag}
						/>
					) : null}

					<FinanceList
						payments={visible}
						quote={quote}
						from={view.from}
						selectedId={view.payment}
						onEdit={(payment) => {
							setFormError(undefined);
							setForm({ kind: 'edit', payment });
						}}
						onDuplicate={(payment) => {
							setFormError(undefined);
							setForm({ kind: 'create', from: payment });
						}}
						onCancel={(payment) => {
							setDialogError(undefined);
							setCancelling(payment);
						}}
						onDelete={(payment) => {
							setDialogError(undefined);
							setDeleting(payment);
						}}
					/>
				</>
			)}

			<PaymentFormDialog
				target={form}
				tags={tags}
				busy={dialogBusy}
				error={formError}
				onSubmit={(draft) => void submitForm(draft)}
				onClose={() => setForm(undefined)}
			/>

			<PaymentDeleteDialog
				target={deleting}
				busy={dialogBusy}
				error={dialogError}
				onConfirm={() => void confirmDelete()}
				onClose={() => setDeleting(undefined)}
			/>

			<SubscriptionCancelDialog
				target={cancelling}
				busy={dialogBusy}
				error={dialogError}
				onConfirm={(endedAt) => void confirmCancel(endedAt)}
				onClose={() => setCancelling(undefined)}
			/>

			<BudgetDialog
				open={editingBudget}
				budget={settings.budget}
				onSave={(budget: FinanceBudget | undefined) => {
					patchSettings({ budget });
					setEditingBudget(false);
				}}
				onClose={() => setEditingBudget(false)}
			/>
		</section>
	);
}
