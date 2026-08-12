import {
	DEFAULT_FINANCE_SETTINGS,
	FINANCE_SETTINGS_KEY,
	loadFinanceSettings,
	reconcileFinanceSettings,
	saveFinanceSettings,
} from '@web/lib/finance-settings';
import { describe, expect, it } from 'vitest';

function fakeStorage(initial?: string) {
	let stored = initial;
	return {
		getItem: () => stored ?? null,
		setItem: (_key: string, value: string) => {
			stored = value;
		},
		read: () => stored,
	};
}

describe('finance settings', () => {
	it('starts with nothing remembered', () => {
		expect(loadFinanceSettings(fakeStorage())).toEqual(
			DEFAULT_FINANCE_SETTINGS,
		);
		expect(DEFAULT_FINANCE_SETTINGS.budget).toBeUndefined();
		expect(DEFAULT_FINANCE_SETTINGS.range).toBeUndefined();
	});

	it('round-trips a budget and the range that was last looked at', () => {
		const storage = fakeStorage();
		const settings = {
			budget: { amount: 2_750_000, currency: 'ars' as const },
			range: {
				from: Date.UTC(2026, 2, 15),
				toExclusive: Date.UTC(2026, 3, 15),
			},
		};

		saveFinanceSettings(storage, settings);
		expect(loadFinanceSettings(storage)).toEqual(settings);
	});

	/** An open bound is a range, not a missing one. */
	it('keeps a range that is open on one side', () => {
		const storage = fakeStorage();
		const range = { from: Date.UTC(2026, 2, 15), toExclusive: null };
		saveFinanceSettings(storage, { range });
		expect(loadFinanceSettings(storage).range).toEqual(range);
	});

	it('keeps a budget with no range, and a range with no budget', () => {
		const budgetOnly = fakeStorage();
		saveFinanceSettings(budgetOnly, {
			budget: { amount: 10, currency: 'usd' },
		});
		expect(loadFinanceSettings(budgetOnly).range).toBeUndefined();
		expect(loadFinanceSettings(budgetOnly).budget).toEqual({
			amount: 10,
			currency: 'usd',
		});
	});

	it.each([
		['malformed json', '{nope'],
		['a shape from another version', '{"version":1,"anchorDay":22}'],
		[
			'a negative budget',
			'{"version":2,"budget":{"amount":-1,"currency":"ars"}}',
		],
		[
			'an unknown currency',
			'{"version":2,"budget":{"amount":10,"currency":"eur"}}',
		],
		// An inverted range would make every filter answer nothing at all.
		[
			'a backwards range',
			'{"version":2,"range":{"from":100,"toExclusive":10}}',
		],
		['a range missing a side', '{"version":2,"range":{"from":100}}'],
		[
			'a range Date cannot hold',
			'{"version":2,"range":{"from":0,"toExclusive":8640000000000001}}',
		],
	])('ignores %s rather than propagating it', (_case, raw) => {
		expect(loadFinanceSettings(fakeStorage(raw))).toEqual(
			DEFAULT_FINANCE_SETTINGS,
		);
	});

	it('survives storage being unavailable', () => {
		const blocked = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
		};

		expect(loadFinanceSettings(blocked)).toEqual(DEFAULT_FINANCE_SETTINGS);
		expect(() =>
			saveFinanceSettings(blocked, DEFAULT_FINANCE_SETTINGS),
		).not.toThrow();
	});

	/** Versioned in the key too, so the previous shape is never half-read. */
	it('is versioned', () => {
		expect(FINANCE_SETTINGS_KEY).toBe('personal-finance-settings:v2');
	});
});

/**
 * The shared copy is the one that decides, so a phone that has never opened
 * Finance adopts the budget instead of starting over. The local copy is not a
 * peer to merge with: it is what seeds the shared one the first time, and the
 * mirror that keeps the screen working with no network.
 */
describe('reconciling with the shared copy', () => {
	const local = { budget: { amount: 1_000, currency: 'ars' as const } };
	const shared = {
		budget: { amount: 3_000_000, currency: 'ars' as const },
		range: { from: 10_000, toExclusive: 20_000 },
	};

	it('adopts the shared copy when there is one', () => {
		expect(reconcileFinanceSettings(shared, local)).toEqual({
			settings: shared,
			push: false,
		});
	});

	it('seeds the shared copy from local when there is none', () => {
		expect(reconcileFinanceSettings(null, local)).toEqual({
			settings: local,
			push: true,
		});
	});

	it('falls back to nothing remembered when neither has anything', () => {
		expect(reconcileFinanceSettings(null, DEFAULT_FINANCE_SETTINGS)).toEqual({
			settings: DEFAULT_FINANCE_SETTINGS,
			push: false,
		});
	});

	/**
	 * An emptied shared copy is a value, not an absence: it is how clearing a
	 * budget on one device reaches the others. Pushing local back over it would
	 * undo the clear on the next open.
	 */
	it('lets an emptied shared copy clear the local one', () => {
		expect(reconcileFinanceSettings({}, local)).toEqual({
			settings: {},
			push: false,
		});
	});

	/** A range with both sides open is "all of time", which is a real choice. */
	it('counts an open range as something worth sharing', () => {
		const open = { range: { from: null, toExclusive: null } };
		expect(reconcileFinanceSettings(null, open)).toEqual({
			settings: open,
			push: true,
		});
	});
});
