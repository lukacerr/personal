import type { MermaidConfig, MermaidInstance } from '@streamdown/mermaid';

/**
 * Mermaid draws with its own palette, which is light: on this shell the
 * diagrams came out as white boxes on a dark page. The app is dark-only —
 * `root.tsx` hard-codes the class — so one theme is the whole decision, and
 * mapping every token by hand would buy nothing over mermaid's own dark set.
 * Agent and Notes share it so a diagram looks the same in a chat and in a note.
 */
export const MERMAID_CONFIG = {
	theme: 'dark',
	// Flowcharts label nodes with HTML inside `<foreignObject>` by default and
	// lay them out from a `getBoundingClientRect` of that HTML. On Windows
	// (Chromium and WebView2 alike) that layout fell apart: in Edge 157 a
	// fourteen-node chart spread its nodes about 2000 units apart, a 5513×18979
	// viewBox, and fit into the note as an unreadable thumbnail, while
	// sequence diagrams — plain SVG text — were fine on the same machine. With
	// SVG text, measured with `getBBox`, the same chart is 749×1231 at every
	// display scale. It has to be the global flag — mermaid 11 nodes read only
	// this one, and `flowchart.htmlLabels` (now deprecated) switched nothing but
	// subgraph titles. The bug also depends on the Chromium version: the
	// Electron browser in T3 Code (Chromium 152) draws the HTML labels fine, so
	// check a change here in Edge. Neither Notes nor Agent uses markdown or
	// icons inside labels, which is what HTML labels buy.
	htmlLabels: false,
} as const satisfies MermaidConfig;

export type MermaidRender =
	| { kind: 'ok'; svg: string }
	| { kind: 'invalid'; message: string };

let instance: Promise<MermaidInstance> | undefined;

/**
 * Mermaid is a large bundle and most notes never hold a diagram, so it loads on
 * the first render instead of with the route. Streamdown's plugin owns the
 * initialization (strict security level, no error SVGs, one `initialize`), and
 * reusing it keeps Agent and Notes on the same instance and config.
 */
function loadMermaid() {
	instance ??= import('@streamdown/mermaid').then(({ mermaid }) =>
		mermaid.getMermaid(MERMAID_CONFIG),
	);
	return instance;
}

/**
 * `id` must be unique per render and a valid CSS id selector: mermaid looks its
 * scratch element up with `#id`, so callers prefix anything that may start with
 * a digit.
 */
export async function renderMermaid(
	source: string,
	id: string,
): Promise<MermaidRender> {
	try {
		const { svg } = await (await loadMermaid()).render(id, source);
		return { kind: 'ok', svg };
	} catch (error) {
		return {
			kind: 'invalid',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
