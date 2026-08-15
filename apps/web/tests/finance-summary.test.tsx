// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import {
	FinanceSummary,
	fittedScale,
} from '@web/components/finance/finance-summary';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function renderSummary(
	overrides: Partial<React.ComponentProps<typeof FinanceSummary>> = {},
) {
	render(
		<FinanceSummary
			totals={{
				ars: 1_526_345,
				usd: 1_041.26,
				count: 8,
				subscriptions: 6,
				recurringArs: 1_385_345,
				oneOffArs: 141_000,
				unconvertible: 0,
				approximate: 0,
			}}
			budget={undefined}
			remaining={undefined}
			quote={{
				compra: 1465,
				venta: 1515,
				fetchedAt: Date.now(),
				stale: false,
			}}
			quoteFailed={false}
			onEditBudget={vi.fn()}
			onRefreshQuote={vi.fn()}
			{...overrides}
		/>,
	);
}

describe('Finance summary', () => {
	/**
	 * The columns answer to the space the summary actually got, not to the
	 * viewport. The sidebar is collapsible and resizable between 224 and 384px, so
	 * one 1080px window hands these cards anywhere from 149 to 244px of content —
	 * a viewport breakpoint picking four columns clipped a peso total against the
	 * card's own `overflow-hidden` whenever the sidebar happened to be open.
	 */
	it('sizes the columns against its container, not the viewport', () => {
		renderSummary();

		const grid = screen
			.getByText('USD rate')
			.closest('[data-slot="card"]')?.parentElement;

		expect(grid?.className).toContain('@min-[60rem]/summary:grid-cols-4');
		expect(grid?.parentElement?.className).toContain('@container/summary');
		expect(grid?.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):grid-cols/);
	});

	/**
	 * The figure answers to the card holding it, not to a breakpoint. Three fixed
	 * tiers had already been wrong on three devices — the last one a flip cover
	 * screen — because a card's width is not a function of the window, and a
	 * system font scale moves the text without moving the card at all.
	 */
	it('sizes the totals against their own card', () => {
		renderSummary();

		const value = screen
			.getByText('Total in pesos')
			.closest('[data-slot="card"]')
			?.querySelector('span[title]');

		expect(value?.className).toMatch(/text-\[min\([^)]*cqi\)\]/);
		// Sized against the card, so the card is what has to be the container.
		expect(value?.closest('[data-slot="card"]')?.className).toContain(
			'@container',
		);
	});

	/**
	 * A phone holds two of these across, and one card per row spent the width on
	 * nothing while pushing the breakdown and the list a screen down. One column
	 * is left for a container too narrow to split without clipping a total.
	 */
	it('goes two up on a phone rather than one', () => {
		renderSummary();

		const grid = screen
			.getByText('USD rate')
			.closest('[data-slot="card"]')?.parentElement;

		expect(grid?.className).toContain('@xs/summary:grid-cols-2');
	});

	/**
	 * The cards share a grid row, so one of them carrying an extra line makes all
	 * four that much taller. The budget used to sit on a line of its own under
	 * Left over and pushed every card ~40px past what it had to say.
	 */
	it('gives every card the same number of lines', () => {
		renderSummary({
			budget: { amount: 2_750_000, currency: 'ars' },
			remaining: { ars: 1_223_655, usd: 835.87 },
		});

		const lines = [...document.querySelectorAll('[data-slot="card"]')].map(
			(card) => card.children.length,
		);

		expect(lines).toHaveLength(4);
		expect(new Set(lines).size).toBe(1);
	});

	/**
	 * The cqi sizing answers to the card, but a system font scale (the WebView's
	 * text zoom) multiplies whatever font the stylesheet computes without growing
	 * the card — no coefficient can see it. The only thing that can is a
	 * measurement of the rendered overflow, so the figure shrinks by that.
	 */
	describe('fittedScale', () => {
		it('keeps the scale of a figure that already fits', () => {
			expect(fittedScale(1, 100, 120)).toBe(1);
		});

		it('shrinks a figure in proportion to its overflow', () => {
			expect(fittedScale(1, 200, 100)).toBe(0.5);
		});

		it('compounds across passes, since what it sets gets zoomed too', () => {
			expect(fittedScale(0.5, 120, 100)).toBeCloseTo(5 / 12, 5);
		});

		/** Below the floor the ellipsis takes over: a cut figure at least says so. */
		it('stops shrinking at the floor', () => {
			expect(fittedScale(1, 1_000, 100)).toBe(0.4);
		});

		/** A test DOM has no layout; zero widths must read as nothing to do. */
		it('ignores degenerate measurements', () => {
			expect(fittedScale(1, 0, 0)).toBe(1);
		});
	});

	/**
	 * The age is computed once per render and then sits still, so the absolute
	 * time rides along in the title as the honest fallback for a card that has
	 * been on screen a while.
	 */
	it('carries the absolute quote time behind the relative age', () => {
		const fetchedAt = Date.now() - 5 * 60_000;
		renderSummary({
			quote: { compra: 1465, venta: 1515, fetchedAt, stale: false },
		});

		const age = screen.getByText('5m ago');
		expect(age.getAttribute('title')).toBe(
			new Date(fetchedAt).toLocaleString(),
		);
	});

	/** Still editable, and still next to the number it is the denominator of. */
	it('keeps the budget on the line that carries the leftover detail', () => {
		renderSummary({
			budget: { amount: 2_750_000, currency: 'ars' },
			remaining: { ars: 1_223_655, usd: 835.87 },
		});

		const row = screen.getByRole('button', { name: /budget/i }).parentElement;

		// Normalised, because `Intl.NumberFormat` separates with a hard space.
		const text = row?.textContent?.replace(/\s+/g, ' ');

		expect(row?.getAttribute('data-slot')).not.toBe('card');
		expect(text).toContain('US$ 835,87');
		expect(text).toContain('$ 2.750.000');
	});
});
