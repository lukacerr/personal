import {
	DISPLAY_MATH_INPUT_RULE,
	equationExitSide,
	INLINE_MATH_INPUT_RULE,
	inlineEquationEntry,
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
			expect(opensDisplayEquation(blockText, '$')).toBe(opens);
		},
	);

	/** The slash menu reaches the same rule through its own leftover trigger. */
	it.each([
		['/', true],
		['', true],
		['/keep me', false],
		['keep me', false],
	])(
		'only replaces a block holding nothing but the slash — %s: %s',
		(blockText, opens) => {
			expect(opensDisplayEquation(blockText, '/')).toBe(opens);
		},
	);
});

/**
 * An inline equation is an unselectable atom, so the caret can only ever sit on
 * one of its sides. Each case is the keystroke that would otherwise cross it.
 */
describe('Notes inline equation entry', () => {
	const caret = {
		collapsed: true,
		nodeBefore: 'text' as string | undefined,
		nodeAfter: 'text' as string | undefined,
	};

	it('opens the equation the caret is about to cross', () => {
		expect(
			inlineEquationEntry({ ...caret, key: 'ArrowRight', nodeAfter: 'latex' }),
		).toBe('before');
		expect(
			inlineEquationEntry({ ...caret, key: 'ArrowLeft', nodeBefore: 'latex' }),
		).toBe('after');
	});

	it('leaves the caret alone when it is not moving into an equation', () => {
		expect(
			inlineEquationEntry({ ...caret, key: 'ArrowRight', nodeBefore: 'latex' }),
		).toBeUndefined();
		expect(
			inlineEquationEntry({ ...caret, key: 'ArrowLeft', nodeAfter: 'latex' }),
		).toBeUndefined();
		expect(
			inlineEquationEntry({ ...caret, key: 'ArrowRight' }),
		).toBeUndefined();
		expect(
			inlineEquationEntry({ ...caret, key: 'a', nodeAfter: 'latex' }),
		).toBeUndefined();
	});

	it('collapses a live selection instead of opening the equation', () => {
		expect(
			inlineEquationEntry({
				...caret,
				key: 'ArrowRight',
				nodeAfter: 'latex',
				collapsed: false,
			}),
		).toBeUndefined();
	});
});

describe('Notes equation exit', () => {
	const input = {
		shiftKey: false,
		displayMode: false,
		caretStart: 0,
		caretEnd: 0,
		length: 5,
		origin: 'before' as const,
	};

	it('returns Escape to the side the caret came from', () => {
		expect(equationExitSide({ ...input, key: 'Escape' })).toBe('before');
		expect(equationExitSide({ ...input, key: 'Escape', origin: 'after' })).toBe(
			'after',
		);
	});

	it('leaves an inline equation only at the ends of its text', () => {
		const atEnd = { ...input, caretStart: 5, caretEnd: 5 };
		const midway = { ...input, caretStart: 2, caretEnd: 2 };

		expect(equationExitSide({ ...input, key: 'ArrowLeft' })).toBe('before');
		expect(equationExitSide({ ...atEnd, key: 'ArrowRight' })).toBe('after');
		expect(equationExitSide({ ...midway, key: 'ArrowLeft' })).toBeUndefined();
		expect(equationExitSide({ ...midway, key: 'ArrowRight' })).toBeUndefined();
	});

	it('leaves a display equation vertically from anywhere in its text', () => {
		const midway = { ...input, displayMode: true, caretStart: 2, caretEnd: 2 };

		expect(equationExitSide({ ...midway, key: 'ArrowUp' })).toBe('before');
		expect(equationExitSide({ ...midway, key: 'ArrowDown' })).toBe('after');
	});

	it('keeps vertical keys inside an inline equation, which has nowhere to go', () => {
		expect(equationExitSide({ ...input, key: 'ArrowUp' })).toBeUndefined();
		expect(equationExitSide({ ...input, key: 'ArrowDown' })).toBeUndefined();
	});

	it('commits to the far side on Enter, and keeps Shift+Enter inside', () => {
		expect(equationExitSide({ ...input, key: 'Enter' })).toBe('after');
		expect(
			equationExitSide({ ...input, key: 'Enter', shiftKey: true }),
		).toBeUndefined();
	});

	it('lets Shift and a live selection move within the LaTeX instead', () => {
		expect(
			equationExitSide({ ...input, key: 'ArrowLeft', shiftKey: true }),
		).toBeUndefined();
		expect(
			equationExitSide({
				...input,
				key: 'ArrowLeft',
				caretStart: 0,
				caretEnd: 3,
			}),
		).toBeUndefined();
	});
});
