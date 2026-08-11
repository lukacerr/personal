import { authPlugin } from '@api/auth';
import { readUsdRate } from '@api/dolar';
import { db } from '@api/env';
import { entityTag, isUnchanged } from '@api/http-cache';
import { payment } from '@api/schema';
import { desc, eq } from 'drizzle-orm';
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

/** Largest instant `Date` can represent, so a timestamp never becomes `Invalid Date`. */
const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;
const timestampMs = z.number().int().nonnegative().max(TIMESTAMP_MAX_MS);

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

export const paymentsRouter = new Elysia({
	prefix: '/payments',
	tags: ['Finance'],
})
	.use(authPlugin)
	.get(
		'/',
		async ({ request, set }) => {
			const payments = await db
				.select(paymentColumns)
				.from(payment)
				.orderBy(desc(payment.paidAt))
				.$withCache(false);

			const payload = payments.map(serialize);
			const tag = entityTag(payload);
			set.headers.etag = tag;
			return isUnchanged(request, tag) ? status(304) : payload;
		},
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
				paidAt: timestampMs.optional(),
				endedAt: timestampMs.nullable().default(null),
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
				.limit(1)
				.$withCache(false);

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
				.limit(1)
				.$withCache(false);

			if (!current) return status(404, { error: 'PAYMENT_NOT_FOUND' });

			// Merged against what is stored, so patching one half of the window is
			// still checked against the half that stays.
			const paidAt = body.paidAt ?? current.paidAt.getTime();
			const endedAt =
				body.endedAt === undefined
					? (current.endedAt?.getTime() ?? null)
					: body.endedAt;
			const isSubscription = body.isSubscription ?? current.isSubscription;

			const invalid = invalidWindow({ isSubscription, paidAt, endedAt });
			if (invalid) return status(422, { error: invalid });

			/**
			 * The frozen quote is never touched, not even when the currency changes.
			 * Stamping today's number onto an old row would rewrite what that expense
			 * cost; and since both sides are stored, a currency correction already
			 * has the side it needs.
			 */
			const [updated] = await db
				.update(payment)
				.set({
					title: body.title,
					tag: body.tag,
					value: body.value,
					currency: body.currency,
					isSubscription: body.isSubscription,
					paidAt: body.paidAt === undefined ? undefined : new Date(paidAt),
					endedAt:
						body.endedAt === undefined
							? undefined
							: endedAt === null
								? null
								: new Date(endedAt),
				})
				.where(eq(payment.id, params.id))
				.returning(paymentColumns);

			if (!updated) return status(404, { error: 'PAYMENT_NOT_FOUND' });
			return serialize(updated);
		},
		{
			params: z.object({ id: paymentId }),
			body: z.object({
				title: paymentTitle.optional(),
				tag: paymentTag.optional(),
				value: paymentValue.optional(),
				currency: paymentCurrency.optional(),
				isSubscription: z.boolean().optional(),
				paidAt: timestampMs.optional(),
				endedAt: timestampMs.nullable().optional(),
			}),
			detail: { summary: 'Update a payment' },
		},
	)
	.delete(
		'/:id',
		async ({ params }) => {
			await db.delete(payment).where(eq(payment.id, params.id));
			return status(204);
		},
		{
			params: z.object({ id: paymentId }),
			detail: { summary: 'Delete a payment' },
		},
	);
