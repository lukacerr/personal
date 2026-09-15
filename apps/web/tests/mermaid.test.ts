import { MERMAID_CONFIG } from '@web/lib/mermaid';
import { describe, expect, it } from 'vitest';

describe('MERMAID_CONFIG', () => {
	// Flowchart labels are SVG text on purpose: HTML labels measured through
	// `<foreignObject>` inflated node boxes on Windows and left the chart
	// unreadable at 1:1. Turning them back on would bring that bug back.
	it('keeps flowchart labels as SVG text', () => {
		expect(MERMAID_CONFIG.flowchart.htmlLabels).toBe(false);
	});
});
