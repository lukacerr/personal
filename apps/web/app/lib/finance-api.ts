import { authenticatedApi } from '@web/lib/authenticated-api';
import type { FinanceSettings } from '@web/lib/finance-settings';
import { conditionalGet } from '@web/lib/http-conditional';
import type { TreatyData } from '@web/lib/treaty-data';

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
export function listPayments(
	knownTag?: string,
): Promise<{ payments: Payment[]; tag?: string } | 'unchanged'> {
	return conditionalGet(
		knownTag,
		(conditional) => authenticatedApi.payments.get(conditional),
		(response) => {
			if (response.status !== 200 || !Array.isArray(response.data))
				throw new FinanceApiError(response.status);
			return { payments: response.data };
		},
	);
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

/**
 * The shared budget and range.
 *
 * A read that cannot be answered comes back `null`, the same as a cache with
 * nothing in it: both mean "no shared copy to adopt", and the screen falls
 * through to what this device remembered. A write says whether it landed, so the
 * caller can tell the difference between saved everywhere and saved here.
 */
export async function readSharedSettings(): Promise<FinanceSettings | null> {
	const response = await authenticatedApi.payments.settings.get();
	if (response.status !== 200 || !response.data) return null;
	return response.data.settings;
}

export async function writeSharedSettings(settings: FinanceSettings) {
	const response = await authenticatedApi.payments.settings.put(settings);
	return response.status === 200;
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
