import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Declarations of the reduced-motion rule that targets every element. */
async function universalReducedMotionRule() {
	const css = (await readFile('app/app.css', 'utf8')).replaceAll('\r\n', '\n');
	const block = css.match(
		/@media \(prefers-reduced-motion: reduce\) \{\s*\*,[^{]*\{([^}]*)\}/,
	);
	if (!block?.[1]) throw new Error('universal reduced-motion rule not found');
	return new Map(
		block[1]
			.split(';')
			.map((declaration) => declaration.split(':').map((part) => part.trim()))
			.filter(([property, value]) => property && value)
			.map(([property, value]) => [property, value]),
	);
}

describe('reduced motion', () => {
	// Every element has `transition-property: all`, so any nonzero duration
	// here turns every style change on the page into a transition, and a
	// transition reports its starting value until the next frame. Mermaid sets
	// each node's `transform` and measures the drawing with `getBBox` in the
	// same tick, so with reduced motion on — Windows with animation effects off
	// — every node read as sitting at the origin and the viewBox came out
	// shifted and too small, cutting the chart off.
	it('does not start a transition on elements that declare none', async () => {
		const rule = await universalReducedMotionRule();
		const duration = rule.get('transition-duration') ?? '0s';
		expect(Number.parseFloat(duration)).toBe(0);
	});
});
