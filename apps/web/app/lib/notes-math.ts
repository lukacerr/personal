import katex from 'katex';

export const LATEX_INLINE_TYPE = 'latex';
export const EQUATION_BLOCK_TYPE = 'equation';

/** Which side of an equation the caret sits on. */
export type MathSide = 'before' | 'after';

/**
 * Decides when an arrow key next to an inline equation should open its editor
 * rather than step over it.
 *
 * BlockNote builds content-less inline content as an unselectable atom, so the
 * caret crosses an equation in a single press and no selection can ever land on
 * it. The answer is the side the caret is on, so that backing out of the editor
 * returns the caret where it started instead of teleporting across the equation.
 *
 * Shift and Mod arrows are absent on purpose: ProseMirror's keymap resolves
 * those to their own bindings, so this only ever sees a bare arrow. A dragged
 * selection does reach it, and collapsing that selection must win over opening.
 */
export function inlineEquationEntry({
	key,
	collapsed,
	nodeBefore,
	nodeAfter,
}: {
	key: string;
	collapsed: boolean;
	nodeBefore: string | undefined;
	nodeAfter: string | undefined;
}): MathSide | undefined {
	if (!collapsed) return undefined;
	if (key === 'ArrowRight' && nodeAfter === LATEX_INLINE_TYPE) return 'before';
	if (key === 'ArrowLeft' && nodeBefore === LATEX_INLINE_TYPE) return 'after';
	return undefined;
}

/**
 * Decides where the caret goes when a key leaves the LaTeX input.
 *
 * Every exit commits, Escape included: an equation reached with the arrow keys
 * belongs to the same typing flow as the text around it, and a keystroke that
 * silently threw away what was typed would be worse than one undo away.
 *
 * A display equation is a one-line field standing in for an entire block, so
 * the vertical keys leave it from anywhere. An inline one sits inside a line
 * and only leaves at the ends of its text, where the arrow has nowhere else to
 * go — otherwise it could never be edited past its first character.
 */
export function equationExitSide({
	key,
	shiftKey,
	displayMode,
	caretStart,
	caretEnd,
	length,
	origin,
}: {
	key: string;
	shiftKey: boolean;
	displayMode: boolean;
	caretStart: number;
	caretEnd: number;
	length: number;
	origin: MathSide;
}): MathSide | undefined {
	if (key === 'Escape') return origin;
	if (key === 'Enter') return shiftKey ? undefined : 'after';
	if (shiftKey || caretStart !== caretEnd) return undefined;
	if (key === 'ArrowLeft' && caretStart === 0) return 'before';
	if (key === 'ArrowRight' && caretStart === length) return 'after';
	if (!displayMode) return undefined;
	if (key === 'ArrowUp') return 'before';
	if (key === 'ArrowDown') return 'after';
	return undefined;
}

/**
 * Dollars only become math when they hug their content, the way Obsidian reads
 * them: an opening `$` followed by a space, or a closing one preceded by a
 * space, is a currency amount. Without that, "it costs $5 and $10" would turn
 * the middle of the sentence into an equation.
 */
export const INLINE_MATH_INPUT_RULE = /\$([^\s$](?:[^$]*[^\s$])?)\$$/;

export const DISPLAY_MATH_INPUT_RULE = /^\$\$$/;

/**
 * A display equation replaces its whole block and holds no text of its own, so
 * it may only take over a block with nothing else in it. Typing `$$` in front of
 * a sentence has to leave the sentence alone instead of deleting it.
 *
 * Every way of reaching an equation still has its own trigger sitting in the
 * block when this runs, and each states which one to discount, so that adding a
 * third entry point cannot quietly skip the rule.
 */
export function opensDisplayEquation(blockText: string, trigger: string) {
	return blockText.replaceAll(trigger, '').trim() === '';
}

export type LatexRenderResult =
	| { kind: 'empty' }
	| { kind: 'invalid' }
	| { kind: 'valid'; html: string };

export function renderLatex(
	latex: string,
	displayMode: boolean,
): LatexRenderResult {
	if (!latex.trim()) return { kind: 'empty' };
	try {
		return {
			kind: 'valid',
			html: katex.renderToString(latex, {
				displayMode,
				output: 'htmlAndMathml',
				throwOnError: true,
			}),
		};
	} catch {
		return { kind: 'invalid' };
	}
}
