import {
	DEFAULT_FINANCE_SETTINGS,
	FINANCE_SETTINGS_KEY,
	loadFinanceSettings,
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
