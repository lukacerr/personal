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
import {
	createCoalescedRequest,
	createIndexCore,
	type IndexCore,
	type IndexLoadOutcome,
	offlineMessage,
} from '@web/lib/index-store';
import {
	createSessionWorkGuard,
	type SessionWorkGuard,
} from '@web/lib/session-work';
import { create } from 'zustand';

export type LiveQuote = UsdQuote & { fetchedAt: number; stale: boolean };

type FinanceState = IndexCore & {
	payments: Payment[];
	quote?: LiveQuote;
	/** Distinct from `error`: the ledger can load fine with no quote behind it. */
	quoteFailed: boolean;
	load: (
		force?: boolean,
		isCurrent?: SessionWorkGuard,
	) => Promise<IndexLoadOutcome>;
	loadQuote: (force?: boolean, isCurrent?: SessionWorkGuard) => Promise<void>;
	reset: () => void;
	upsert: (payments: Payment[]) => void;
	remove: (ids: string[]) => void;
	record: (draft: PaymentDraft) => Promise<string | undefined>;
	revise: (
		id: string,
		changes: Partial<PaymentDraft>,
	) => Promise<string | undefined>;
	discard: (id: string) => Promise<string | undefined>;
};

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
	const index = createIndexCore<FinanceState, Payment>({
		get,
		patch: ({ items, ...core }) =>
			set(items ? { ...core, payments: items } : core),
		read: async (knownTag) => {
			const answer = await listPayments(knownTag);
			return answer === 'unchanged'
				? answer
				: { items: answer.payments, tag: answer.tag };
		},
		select: (state) => state.payments,
		failure: {
			unreachable:
				'Your payments could not reach the server. Try again in a moment.',
			offline: 'No connection. Finance needs to reach the server.',
		},
	});
	const quoteRequest = createCoalescedRequest<void>();

	return {
		payments: [],
		quoteFailed: false,
		...index,

		async loadQuote(force = false, isCurrent = createSessionWorkGuard()) {
			if (quoteRequest.pending) return quoteRequest.pending;
			if (!force && get().quote) return;
			if (!isCurrent?.()) return;

			return quoteRequest.run(async () => {
				try {
					const quote = await readUsdQuote();
					if (!isCurrent()) return;
					set({ quote, quoteFailed: quote === undefined });
				} catch {
					if (!isCurrent()) return;
					set({ quoteFailed: true });
				}
			});
		},

		reset() {
			quoteRequest.clear();
			index.reset();
			set({ quote: undefined, quoteFailed: false });
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
				return offlineMessage('This payment');
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
				return offlineMessage('This change');
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
				return offlineMessage('This deletion');
			}
		},
	};
});

/** Reads the index without subscribing, for the system registry's loaders. */
export const financeSnapshot = () => useFinanceStore.getState();
