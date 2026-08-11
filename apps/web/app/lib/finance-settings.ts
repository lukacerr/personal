import { z } from 'zod';

/**
 * The two things that are Luka's rather than the ledger's: the budget a period
 * is measured against, and the last range he looked at.
 *
 * Neither belongs on the server — the budget because there is no reason for it
 * to leave this browser, and the range because it is how he reads the data, not
 * the data. The range is remembered rather than derived: a card that opens and
 * closes on irregular days, without a fixed length, cannot be computed from an
 * anchor, so the honest model is "whatever you picked last time".
 */

export const FINANCE_SETTINGS_KEY = 'personal-finance-settings:v2';

/** Bounded so a stored timestamp can never become an `Invalid Date`. */
const TIMESTAMP_MAX_MS = 8_640_000_000_000_000;
const timestamp = z.number().int().nonnegative().max(TIMESTAMP_MAX_MS);

const settingsSchema = z.object({
	version: z.literal(2),
	budget: z
		.object({
			amount: z.number().positive().max(999_999_999_999.99),
			currency: z.enum(['ars', 'usd']),
		})
		.optional(),
	// Either side may be null: an open bound is a range, not a missing one.
	range: z
		.object({
			from: timestamp.nullable(),
			toExclusive: timestamp.nullable(),
		})
		.refine(
			({ from, toExclusive }) =>
				from === null || toExclusive === null || from < toExclusive,
		)
		.optional(),
});

export type FinanceBudget = { amount: number; currency: 'ars' | 'usd' };
export type FinanceRange = { from: number | null; toExclusive: number | null };
export type FinanceSettings = { budget?: FinanceBudget; range?: FinanceRange };

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {};

export function loadFinanceSettings(
	storage: Pick<SettingsStorage, 'getItem'>,
): FinanceSettings {
	try {
		const raw = storage.getItem(FINANCE_SETTINGS_KEY);
		if (!raw) return DEFAULT_FINANCE_SETTINGS;
		const parsed = settingsSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return DEFAULT_FINANCE_SETTINGS;

		// Built key by key rather than spread, so an absent field stays absent
		// instead of becoming a present `undefined`.
		const settings: FinanceSettings = {};
		if (parsed.data.budget) settings.budget = parsed.data.budget;
		if (parsed.data.range) settings.range = parsed.data.range;
		return settings;
	} catch {
		return DEFAULT_FINANCE_SETTINGS;
	}
}

export function saveFinanceSettings(
	storage: Pick<SettingsStorage, 'setItem'>,
	settings: FinanceSettings,
) {
	try {
		storage.setItem(
			FINANCE_SETTINGS_KEY,
			JSON.stringify({ version: 2, ...settings }),
		);
	} catch {
		// Best-effort: storage can be full or blocked, and neither is worth losing
		// the screen over.
	}
}
