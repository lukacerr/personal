import { MERMAID_CONFIG } from '@web/lib/mermaid';
import { describe, expect, it } from 'vitest';

describe('MERMAID_CONFIG', () => {
	// Labels are SVG text on purpose: HTML labels measured through
	// `<foreignObject>` inflated node boxes on Windows and left the chart
	// unreadable at 1:1. The flag has to be the global one: mermaid 11 nodes
	// ignore `flowchart.htmlLabels`, which is how an earlier fix shipped without
	// changing a single node.
	it('keeps diagram labels as SVG text', () => {
		expect(MERMAID_CONFIG.htmlLabels).toBe(false);
	});
});
