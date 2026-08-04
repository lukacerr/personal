import {
	clampSidebarWidth,
	getSidebarTransitionClass,
} from '@web/lib/sidebar-size';
import { describe, expect, it } from 'vitest';

describe('sidebar resizing', () => {
	it('keeps the width within comfortable desktop limits', () => {
		expect(clampSidebarWidth(180)).toBe(224);
		expect(clampSidebarWidth(300)).toBe(300);
		expect(clampSidebarWidth(500)).toBe(384);
	});

	it('disables width transitions while manually resizing', () => {
		expect(getSidebarTransitionClass(true)).toBe('transition-none');
		expect(getSidebarTransitionClass(false)).toContain('duration-100');
	});
});
