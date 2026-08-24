// @vitest-environment happy-dom

import { render } from '@testing-library/react';
import { Response } from '@web/components/agent/elements/response';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('the markdown renderer', () => {
	it('renders inline math mid-sentence', () => {
		const { container } = render(
			<Response>{'La ecuación $E = mc^2$ es famosa.'}</Response>,
		);
		// KaTeX leaves its own markup behind; the raw dollars must be gone.
		expect(container.querySelector('.katex')).not.toBeNull();
		expect(container.textContent).not.toContain('$E = mc^2$');
	});

	/**
	 * Display math needs its delimiters on their own lines. A one-liner
	 * `$$x = 1$$` still renders — as inline math — which is why the difference
	 * is easy to miss and worth pinning: the system prompt asks the model for
	 * the fenced form so equations land centred.
	 */
	it('renders fenced display math as a block, and a one-liner inline', () => {
		const fenced = render(
			<Response>
				{'Antes.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n\nDespués.'}
			</Response>,
		);
		expect(fenced.container.querySelector('.katex-display')).not.toBeNull();
		fenced.unmount();

		const oneLine = render(
			<Response>{'Antes.\n\n$$x = 1$$\n\nDespués.'}</Response>,
		);
		expect(oneLine.container.querySelector('.katex')).not.toBeNull();
		expect(oneLine.container.querySelector('.katex-display')).toBeNull();
	});

	it('marks ==highlighted== text', () => {
		const { container } = render(
			<Response>{'Esto es ==muy importante== acá.'}</Response>,
		);
		/*
		 * `mark` is not on the sanitizer's default allowlist, so without the
		 * `allowedTags` opt-in this used to render as plain text with the `==`
		 * silently eaten — the worst outcome, since it looks like the syntax is
		 * simply unsupported.
		 */
		const mark = container.querySelector('mark');
		expect(mark).not.toBeNull();
		expect(mark?.textContent).toContain('muy importante');
	});

	it('renders GFM tables and strikethrough alongside highlights', () => {
		const { container } = render(
			<Response>
				{
					'~~Descartado~~ y ==elegido==.\n\n| Nombre | Edad |\n| --- | ---: |\n| Ana | 28 |'
				}
			</Response>,
		);

		expect(container.querySelector('del')?.textContent).toBe('Descartado');
		expect(container.querySelector('mark')?.textContent).toBe('elegido');
		expect(container.querySelector('table')).not.toBeNull();
		expect(container.querySelectorAll('th')).toHaveLength(2);
		expect(container.querySelectorAll('td')).toHaveLength(2);
	});

	it('sends a mermaid fence to the diagram renderer, not to a code block', () => {
		const { container } = render(
			<Response>{'```mermaid\nflowchart TD\n  A --> B\n```'}</Response>,
		);
		// The diagram renders through a real layout engine, which happy-dom is
		// not; what is assertable here is that the fence stopped being printed
		// as source. The drawing itself is verified in a browser.
		expect(container.querySelector('pre')).toBeNull();
		expect(container.textContent).not.toContain('flowchart TD');
	});

	/**
	 * The cost of inline math, written down rather than wished away: with
	 * `$…$` live, two amounts in one sentence read as a formula. Escaping is
	 * the way out, and the system prompt asks the model for it.
	 */
	it('keeps escaped currency literal', () => {
		const { container } = render(
			<Response>{'Costó \\$100 y después \\$200 más.'}</Response>,
		);
		expect(container.textContent).toContain('$100');
		expect(container.textContent).toContain('$200');
		expect(container.querySelector('.katex')).toBeNull();
	});
});
