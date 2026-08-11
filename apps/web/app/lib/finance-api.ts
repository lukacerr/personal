import { authenticatedApi } from '@web/lib/authenticated-api';

type TreatyData<T> = T extends (...args: infer _Args) => infer Result
	? Awaited<Result> extends { data: infer Data }
		? NonNullable<Data>
		: never
	: never;

type Payments = Extract<
	TreatyData<typeof authenticatedApi.payments.get>,
	unknown[]
>;

/** The contract itself, never a hand-written copy of it. */
export type Payment = Payments[number];

export type PaymentDraft = {
	title: string;
	tag: string | null;
	value: number;
	currency: 'ars' | 'usd';
	isSubscription: boolean;
	paidAt: number;
	endedAt: number | null;
};

export class FinanceApiError extends Error {
	constructor(readonly status: number) {
		super(`Finance API returned ${status}`);
	}
}

function asPayment(data: unknown, status: number) {
	if (status < 200 || status >= 300 || !data || !('title' in (data as object)))
		throw new FinanceApiError(status);
	return data as Payment;
}

/** The index, or word that the copy already held is still current. */
export async function listPayments(
	knownTag?: string,
): Promise<{ payments: Payment[]; tag?: string } | 'unchanged'> {
	// Through `fetch` rather than `headers`: Eden types the latter as the one
	// header its own contract knows about, and this one is the browser's.
	const response = await authenticatedApi.payments.get(
		knownTag ? { fetch: { headers: { 'if-none-match': knownTag } } } : {},
	);
	if (response.status === 304) return 'unchanged';
	if (response.status !== 200 || !Array.isArray(response.data))
		throw new FinanceApiError(response.status);
	return {
		payments: response.data,
		tag: response.response.headers.get('etag') ?? undefined,
	};
}

/**
 * The live quote, asked for separately from the index. Folding it into the list
 * would put a third party on the critical path of every load and churn the
 * entity tag every half hour over a body that did not change.
 */
export async function readUsdQuote() {
	const response = await authenticatedApi.payments.rate.get();
	if (response.status !== 200 || !response.data || !('venta' in response.data))
		return undefined;
	return response.data;
}

export async function createPayment(draft: PaymentDraft) {
	const response = await authenticatedApi.payments.post(draft);
	return asPayment(response.data, response.status);
}

export async function updatePayment(
	id: string,
	changes: Partial<PaymentDraft>,
) {
	const response = await authenticatedApi.payments({ id }).patch(changes);
	return asPayment(response.data, response.status);
}

export async function deletePayment(id: string) {
	const response = await authenticatedApi.payments({ id }).delete();
	if (response.status !== 204) throw new FinanceApiError(response.status);
}
