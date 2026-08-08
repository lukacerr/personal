import {
	DISPLAY_MATH_INPUT_RULE,
	INLINE_MATH_INPUT_RULE,
	opensDisplayEquation,
	renderLatex,
} from '@web/lib/notes-math';
import { describe, expect, it } from 'vitest';

describe('Notes LaTeX rendering', () => {
	it('renders valid TeX as visual HTML with accessible MathML', () => {
		const result = renderLatex('x^2 + y^2 = z^2', true);

		expect(result).toMatchObject({ kind: 'valid' });
		if (result.kind === 'valid') {
			expect(result.html).toContain('<math');
			expect(result.html).toContain('katex-display');
		}
	});

	it('keeps invalid TeX from breaking the editor', () => {
		expect(renderLatex('\\frac{a', false)).toMatchObject({
			kind: 'invalid',
		});
	});

	it('does not render an empty equation', () => {
		expect(renderLatex('', false)).toEqual({ kind: 'empty' });
	});
});

/**
 * The rules see the text of the block up to the cursor, so each case is what a
 * note looks like at the keystroke that would close the equation.
 */
describe('Notes dollar shorthand', () => {
	it.each([
		['$x$', 'x'],
		['Euler: $e^{i\\pi} + 1 = 0$', 'e^{i\\pi} + 1 = 0'],
		['ends a word$b$', 'b'],
	])('reads %s as inline math', (typed, latex) => {
		expect(typed.match(INLINE_MATH_INPUT_RULE)?.[1]).toBe(latex);
	});

	it.each(['it costs $5 and $', '$ x$', '$x $', '$$', '$x', 'plain text'])(
		'leaves %s as text',
		(typed) => {
			expect(typed.match(INLINE_MATH_INPUT_RULE)).toBeNull();
		},
	);

	it.each([
		['$$', true],
		['text $$', false],
		['$', false],
		['$$x', false],
	])('opens a display equation on %s: %s', (typed, opens) => {
		expect(DISPLAY_MATH_INPUT_RULE.test(typed)).toBe(opens);
	});

	it.each([
		['$', true],
		['', true],
		['$keep me', false],
		['keep me', false],
	])(
		'only replaces a block holding nothing but dollars — %s: %s',
		(blockText, opens) => {
			expect(opensDisplayEquation(blockText)).toBe(opens);
		},
	);
});
