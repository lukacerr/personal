import { authPlugin } from '@api/auth';
import { readUsdRate } from '@api/dolar';
import { db } from '@api/env';
import {
	financeSettingsSchema,
	financeSettingsStore,
} from '@api/finance-settings';
import { createIndexCache } from '@api/http-cache';
import { payment } from '@api/schema';
import { dateTimestampMs } from '@api/validation';
import { and, desc, eq, sql } from 'drizzle-orm';
import Elysia, { status } from 'elysia';
import { z } from 'zod';

const paymentId = z.uuid();
const paymentTitle = z.string().trim().min(1).max(255);
const paymentTag = z.string().trim().min(1).max(64).nullable();
const paymentCurrency = z.enum(['ars', 'usd']);

/**
 * What `numeric(14, 2)` holds. Bounding the range matters more than bounding the
 * scale: the range is what keeps a hostile number out of every sum downstream,
 * while a third decimal is a formatting slip and gets rounded rather than
 * refused.
 */
const MAX_PAYMENT_VALUE = 999_999_999_999.99;
const paymentValue = z
	.number()
	.gt(0)
	.max(MAX_PAYMENT_VALUE)
	.transform((value) => Math.round(value * 100) / 100);

/**
 * Payment instants are user-chosen dates, not sync clocks: a subscription
 * cancelled "effective end of month" ends in the future, so the clock-skew
 * bound on `timestampMs` deliberately does not apply here.
 */
const paymentInstant = dateTimestampMs;

const paymentColumns = {
	id: payment.id,
	title: payment.title,
	tag: payment.tag,
	value: payment.value,
	currency: payment.currency,
	rateBuy: payment.rateBuy,
	rateSell: payment.rateSell,
	isSubscription: payment.isSubscription,
	paidAt: payment.paidAt,
	endedAt: payment.endedAt,
	createdAt: payment.createdAt,
	updatedAt: payment.updatedAt,
};

type PaymentRow = {
	id: string;
	title: string;
	tag: string | null;
	value: number;
	currency: 'ars' | 'usd';
	rateBuy: number | null;
	rateSell: number | null;
	isSubscription: boolean;
	paidAt: Date;
	endedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

/**
 * Timestamps travel as epoch milliseconds, like every other system here. An
 * absent `endedAt` travels as `null` rather than a missing key, so the client
 * never has to tell "still running" apart from "the server did not say".
 */
function serialize(row: PaymentRow) {
	return {
		...row,
		paidAt: row.paidAt.getTime(),
		endedAt: row.endedAt?.getTime() ?? null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * The two model invariants, checked here rather than as CHECK constraints: a
 * 23514 would leave the global handler with nothing but a 500 to say, and the
 * domain message has to be produced in this router either way.
 *
 * `endedAt >= paidAt` is load-bearing beyond tidiness. The client decides
 * whether a subscription falls in a period by branching on `isSubscription`
 * instead of OR-ing the point-in-range and window-overlap forms, and those are
 * only equivalent while a window cannot run backwards.
 */
function invalidWindow(row: {
	isSubscription: boolean;
	paidAt: number;
	endedAt: number | null;
}) {
	if (row.endedAt === null) return undefined;
	if (!row.isSubscription) return 'PAYMENT_END_REQUIRES_SUBSCRIPTION' as const;
	if (row.endedAt < row.paidAt) return 'PAYMENT_ENDED_BEFORE_PAID' as const;
	return undefined;
}

type PaymentPatch = {
	title?: string;
	tag?: string | null;
	value?: number;
	currency?: 'ars' | 'usd';
	isSubscription?: boolean;
	paidAt?: number;
	endedAt?: number | null;
};

/** The window fields the row ends up with after this patch lands on `current`. */
function mergedWindow(current: PaymentRow, body: PaymentPatch) {
	return {
		isSubscription: body.isSubscription ?? current.isSubscription,
		paidAt: body.paidAt ?? current.paidAt.getTime(),
		endedAt:
			body.endedAt === undefined
				? (current.endedAt?.getTime() ?? null)
				: body.endedAt,
	};
}

/**
 * Re-states the window invariants inside the UPDATE itself, over the values the
 * row will actually end up with: a field the patch provides enters as a
 * literal, an omitted one as its own column. The handler validates against the
 * row it read, but a concurrent write can land between that read and the
 * update; evaluating the invariant atomically on the final merged values closes
 * that race instead of trusting the earlier snapshot.
 */
function windowGuard(body: PaymentPatch) {
	// An explicit clear satisfies both invariants whatever else the row holds.
	if (body.endedAt === null) return sql`true`;
	const ended =
		body.endedAt === undefined
			? sql`${payment.endedAt}`
			: sql`${new Date(body.endedAt).toISOString()}::timestamp`;
	const paid =
		body.paidAt === undefined
			? sql`${payment.paidAt}`
			: sql`${new Date(body.paidAt).toISOString()}::timestamp`;
	const isSubscription =
		body.isSubscription === undefined
			? sql`${payment.isSubscription}`
			: body.isSubscription
				? sql`true`
				: sql`false`;
	return sql`(${ended} is null or (${isSubscription} and ${ended} >= ${paid}))`;
}

/**
 * The PATCH's guarded update. Exported because the race it closes cannot be
 * forced deterministically through HTTP: the test simulates the concurrent
 * write itself and then issues this exact statement. Returns nothing when the
 * row is missing or when applying the patch would break the window invariant.
 */
export async function patchPaymentRow(id: string, body: PaymentPatch) {
	const [updated] = await db
		.update(payment)
		.set({
			title: body.title,
			tag: body.tag,
			value: body.value,
			currency: body.currency,
			isSubscription: body.isSubscription,
			paidAt: body.paidAt === undefined ? undefined : new Date(body.paidAt),
			endedAt:
				body.endedAt === undefined
					? undefined
					: body.endedAt === null
						? null
						: new Date(body.endedAt),
		})
		.where(and(eq(payment.id, id), windowGuard(body)))
		.returning(paymentColumns);
	return updated;
}

/**
 * The remembered tag of `GET /payments`, so a poll that changed nothing costs
 * one Redis GET instead of reading the whole ledger out of Neon. Every handler
 * below that writes the `payment` table drops it before responding.
 */
const indexCache = createIndexCache('finance');

export const paymentsRouter = new Elysia({
	prefix: '/payments',
	tags: ['Finance'],
})
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) =>
			indexCache.conditional(request, set, async () => {
				const payments = await db
					.select(paymentColumns)
					.from(payment)
					.orderBy(desc(payment.paidAt));

				return payments.map(serialize);
			}),
		{
			/**
			 * No query parameters on purpose. The entity tag is derived from the
			 * body, so a filtered index means a tag per query string, and stepping
			 * through statement periods — the main interaction — would revalidate
			 * nothing. The visible set is not a subset of the period anyway, since
			 * subscriptions show from outside it.
			 */
			detail: { summary: 'List payments' },
		},
	)
	/** Before `/:id`, which parses its parameter as a uuid and would answer 422. */
	.get(
		'/rate',
		async () => {
			const rate = await readUsdRate();
			if (!rate) return status(503, { error: 'USD_RATE_UNAVAILABLE' });
			return rate;
		},
		{ detail: { summary: 'Read the official USD quote' } },
	)
	/**
	 * The budget and the last range, shared across devices so neither has to be
	 * retyped per phone. `null` means the cache has nothing — distinct from an
	 * empty settings, which is how clearing a budget reaches the other devices.
	 */
	.get(
		'/settings',
		async () => ({ settings: await financeSettingsStore.read() }),
		{ detail: { summary: 'Read the shared finance settings' } },
	)
	.put(
		'/settings',
		async ({ body }) => {
			// A cache that is down is reported as a failure to store, not as a 500:
			// the device keeps its own mirror either way.
			const stored = await financeSettingsStore.write(body);
			if (!stored)
				return status(503, { error: 'FINANCE_SETTINGS_UNAVAILABLE' });
			return { settings: body };
		},
		{
			body: financeSettingsSchema,
			detail: { summary: 'Replace the shared finance settings' },
		},
	)
	.post(
		'/',
		async ({ body }) => {
			const invalid = invalidWindow({
				isSubscription: body.isSubscription,
				paidAt: body.paidAt ?? Date.now(),
				endedAt: body.endedAt,
			});
			if (invalid) return status(422, { error: invalid });

			/**
			 * Best-effort, and never blocking. The reader almost always answers from
			 * cache; when it cannot, the row is written with no quote and the screen
			 * says so. An expense must not be lost because a rate feed was down.
			 */
			const rate = await readUsdRate();

			const [created] = await db
				.insert(payment)
				.values({
					title: body.title,
					tag: body.tag,
					value: body.value,
					currency: body.currency,
					rateBuy: rate?.compra ?? null,
					rateSell: rate?.venta ?? null,
					isSubscription: body.isSubscription,
					paidAt: body.paidAt === undefined ? undefined : new Date(body.paidAt),
					endedAt: body.endedAt === null ? null : new Date(body.endedAt),
				})
				.returning(paymentColumns);
			await indexCache.invalidate();

			if (!created) throw new Error('Insert returned no row');
			return status(201, serialize(created));
		},
		{
			/**
			 * Rates are absent from the body deliberately: they are the server's
			 * observation, and this app is on the public internet.
			 */
			body: z.object({
				title: paymentTitle,
				tag: paymentTag.default(null),
				value: paymentValue,
				currency: paymentCurrency,
				isSubscription: z.boolean().default(false),
				paidAt: paymentInstant.optional(),
				endedAt: paymentInstant.nullable().default(null),
			}),
			detail: { summary: 'Record a payment' },
		},
	)
	.get(
		'/:id',
		async ({ params }) => {
			const [result] = await db
				.select(paymentColumns)
				.from(payment)
				.where(eq(payment.id, params.id))
				.limit(1);

			if (!result) return status(404, { error: 'PAYMENT_NOT_FOUND' });
			return serialize(result);
		},
		{
			params: z.object({ id: paymentId }),
			detail: { summary: 'Get a payment' },
		},
	)
	.patch(
		'/:id',
		async ({ body, params }) => {
			const [current] = await db
				.select(paymentColumns)
				.from(payment)
				.where(eq(payment.id, params.id))
				.limit(1);

			if (!current) return status(404, { error: 'PAYMENT_NOT_FOUND' });

			// Merged against what was read, so patching one half of the window is
			// still checked against the half that stays.
			const invalid = invalidWindow(mergedWindow(current, body));
			if (invalid) return status(422, { error: invalid });

			/**
			 * The frozen quote is never touched, not even when the currency changes.
			 * Stamping today's number onto an old row would rewrite what that expense
			 * cost; and since both sides are stored, a currency correction already
			 * has the side it needs.
			 */
			const updated = await patchPaymentRow(params.id, body);
			await indexCache.invalidate();
			if (updated) return serialize(updated);

			// The guarded update matched nothing: the row is gone, or a concurrent
			// write landed after the read above and the merged values no longer
			// hold the invariant. Answer from the row as it stands now.
			const [fresh] = await db
				.select(paymentColumns)
				.from(payment)
				.where(eq(payment.id, params.id))
				.limit(1);

			if (!fresh) return status(404, { error: 'PAYMENT_NOT_FOUND' });
			const conflict = invalidWindow(mergedWindow(fresh, body));
			// The fallback is only reachable if yet another write made the merge
			// valid between the update and this read; by then the guard's refusal
			// can only have been about the subscription flag.
			return status(422, {
				error: conflict ?? 'PAYMENT_END_REQUIRES_SUBSCRIPTION',
			});
		},
		{
			params: z.object({ id: paymentId }),
			body: z.object({
				title: paymentTitle.optional(),
				tag: paymentTag.optional(),
				value: paymentValue.optional(),
				currency: paymentCurrency.optional(),
				isSubscription: z.boolean().optional(),
				paidAt: paymentInstant.optional(),
				endedAt: paymentInstant.nullable().optional(),
			}),
			detail: { summary: 'Update a payment' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			await db.delete(payment).where(eq(payment.id, params.id));
			await indexCache.invalidate();
			return status(204);
		},
		{
			params: z.object({ id: paymentId }),
			detail: { summary: 'Delete a payment' },
		},
	);
