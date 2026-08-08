import katex from 'katex';

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
 * the shorthand only opens on a block with nothing else in it. Typing `$$` in
 * front of a sentence has to leave the sentence alone instead of deleting it.
 */
export function opensDisplayEquation(blockText: string) {
	return blockText.replaceAll('$', '').trim() === '';
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
