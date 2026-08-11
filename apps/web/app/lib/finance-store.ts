import type { UsdQuote } from '@web/lib/finance';
import {
	createPayment,
	deletePayment,
	listPayments,
	type Payment,
	type PaymentDraft,
	readUsdQuote,
	updatePayment,
} from '@web/lib/finance-api';
import { create } from 'zustand';

type FinanceStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type LiveQuote = UsdQuote & { fetchedAt: number; stale: boolean };

type FinanceState = {
	payments: Payment[];
	status: FinanceStatus;
	error?: string;
	/** What the server called the copy held here, so a refresh can ask for less. */
	tag?: string;
	quote?: LiveQuote;
	/** Distinct from `error`: the ledger can load fine with no quote behind it. */
	quoteFailed: boolean;
	load: (force?: boolean) => Promise<void>;
	loadQuote: (force?: boolean) => Promise<void>;
	record: (draft: PaymentDraft) => Promise<string | undefined>;
	revise: (
		id: string,
		changes: Partial<PaymentDraft>,
	) => Promise<string | undefined>;
	discard: (id: string) => Promise<string | undefined>;
};

const offline = (subject: string) =>
	navigator.onLine
		? `${subject} could not reach the server. Try again in a moment.`
		: `No connection. ${subject} needs to reach the server.`;

/**
 * The one copy of the payment index the app keeps.
 *
 * Finance is not local-first: the API is the source and nothing here is written
 * to a local database. The whole table is fetched once and every filter — the
 * period, the tags, the subscription toggle — runs in memory, because the entity
 * tag is derived from the body and a filtered index would mean a tag per query
 * string, revalidating nothing while stepping through periods.
 *
 * The quote is loaded separately and deliberately: putting a third party on the
 * critical path of the list would slow every load and churn the tag every half
 * hour over a body that did not change.
 */
export const useFinanceStore = create<FinanceState>()((set, get) => {
	let inFlight: Promise<void> | undefined;
	let quoteInFlight: Promise<void> | undefined;

	return {
		payments: [],
		status: 'idle',
		quoteFailed: false,

		async load(force = false) {
			if (inFlight) return inFlight;
			if (!force && get().status === 'ready') return;

			set({ status: 'loading' });
			inFlight = (async () => {
				try {
					const answer = await listPayments(get().tag);
					if (answer === 'unchanged')
						set({ status: 'ready', error: undefined });
					else
						set({
							payments: answer.payments,
							tag: answer.tag,
							status: 'ready',
							error: undefined,
						});
				} catch {
					set({ status: 'failed', error: offline('Your payments') });
				} finally {
					inFlight = undefined;
				}
			})();
			return inFlight;
		},

		async loadQuote(force = false) {
			if (quoteInFlight) return quoteInFlight;
			if (!force && get().quote) return;

			quoteInFlight = (async () => {
				try {
					const quote = await readUsdQuote();
					set({ quote, quoteFailed: quote === undefined });
				} catch {
					set({ quoteFailed: true });
				} finally {
					quoteInFlight = undefined;
				}
			})();
			return quoteInFlight;
		},

		async record(draft) {
			try {
				const created = await createPayment(draft);
				// The tag described what the server sent, and this is no longer that.
				set(({ payments }) => ({
					tag: undefined,
					payments: [created, ...payments],
				}));
			} catch {
				return offline('This payment');
			}
		},

		async revise(id, changes) {
			try {
				const updated = await updatePayment(id, changes);
				set(({ payments }) => ({
					tag: undefined,
					payments: payments.map((row) => (row.id === id ? updated : row)),
				}));
			} catch {
				return offline('This change');
			}
		},

		async discard(id) {
			try {
				await deletePayment(id);
				set(({ payments }) => ({
					tag: undefined,
					payments: payments.filter((row) => row.id !== id),
				}));
			} catch {
				return offline('This deletion');
			}
		},
	};
});

/** Reads the index without subscribing, for the system registry's loaders. */
export const financeSnapshot = () => useFinanceStore.getState();
