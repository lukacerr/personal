import { desc } from 'drizzle-orm';
import {
	boolean,
	index,
	numeric,
	pgTable,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

/**
 * A recorded expense, in pesos or in dollars.
 *
 * There are two clocks here and they must not be conflated. `paidAt` is when the
 * expense happened: it is editable, it defaults to now, and it is the only
 * column a period filters on. `createdAt`/`updatedAt` are row audit and take
 * part in no product query. Entering yesterday's receipt today cannot move it
 * into today's statement.
 *
 * `rateBuy` and `rateSell` freeze the official quote as it stood the moment the
 * row was recorded, and the server stamps them. Converting an old period with
 * today's quote rewrites history: under this inflation, March's spending
 * measured in August dollars is a number that never existed. Both sides are
 * stored even though a row only ever converts in one direction, because the row
 * should record the observation — what the quote was — and not the derived
 * decision of which side applies. That keeps the direction policy in the client,
 * where it is pure and testable, lets it change without a migration, and makes
 * correcting a currency typo harmless instead of silently leaving the wrong side
 * frozen.
 *
 * They are nullable on purpose, and they are written or left null together: if
 * dolarapi does not answer, the row is saved anyway with no quote and the screen
 * says so. An expense must never be lost because a rate API was down. A PATCH
 * never rewrites them — today's quote is not this row's quote.
 *
 * Subscriptions are the exception to the freeze: they convert with the live
 * quote, because they are paid again each month at today's price. That is why a
 * subscription is not a point in time but a **window** — it counts for any
 * period between `paidAt` and `endedAt`. Cancelling writes `endedAt` rather than
 * deleting the row, so past periods keep counting what was actually paid.
 *
 * The two model invariants — `endedAt >= paidAt`, and `endedAt` only alongside
 * `isSubscription` — are enforced in the router and deliberately **not** as
 * CHECK constraints: a 23514 would surface through the global handler as a 500,
 * and the router has to produce the domain message either way.
 */
export const payment = pgTable(
	'payment',
	{
		id: uuid().primaryKey().defaultRandom(),
		title: varchar({ length: 255 }).notNull(),
		/** Free-form grouping for the chart; `null` falls into "Untagged". */
		tag: varchar({ length: 64 }),
		/**
		 * `mode: 'number'` so the contract carries a number rather than the string
		 * plain `numeric` returns, which would put a parse at every call site that
		 * sums. The ceiling this precision allows is two orders of magnitude below
		 * where a two-decimal double stops being exact, so the column bound and the
		 * float-safety bound agree.
		 */
		value: numeric({ precision: 14, scale: 2, mode: 'number' }).notNull(),
		currency: varchar({ length: 3, enum: ['ars', 'usd'] }).notNull(),
		/** Official `compra`, in ARS per USD. Divides when going ARS to USD. */
		rateBuy: numeric({ precision: 12, scale: 4, mode: 'number' }),
		/** Official `venta`, in ARS per USD. Multiplies when going USD to ARS. */
		rateSell: numeric({ precision: 12, scale: 4, mode: 'number' }),
		isSubscription: boolean().notNull().default(false),
		/** When the expense happened, or when the subscription started. */
		paidAt: timestamp().defaultNow().notNull(),
		/** End of a subscription's window; `null` means it is still running. */
		endedAt: timestamp(),
		createdAt: timestamp().defaultNow().notNull(),
		updatedAt: timestamp()
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	// The only index, and it is the index endpoint's ORDER BY. Nothing on `tag`
	// or partial on `isSubscription`: the whole table is fetched once and every
	// filter runs in the client, so those would be cost with no reader.
	(t) => [index('payment_paid_at_desc').on(desc(t.paidAt))],
);
