import { clampSidebarWidth, isAppSidebarShortcut } from '@web/lib/sidebar-size';
import { describe, expect, it } from 'vitest';

describe('sidebar resizing', () => {
	it('keeps the width within comfortable desktop limits', () => {
		expect(clampSidebarWidth(180)).toBe(224);
		expect(clampSidebarWidth(300)).toBe(300);
		expect(clampSidebarWidth(500)).toBe(384);
	});

	it('only toggles the app sidebar for the exact Ctrl/Cmd+B shortcut', () => {
		expect(
			isAppSidebarShortcut({
				key: 'b',
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				repeat: false,
			}),
		).toBe(true);
		expect(
			isAppSidebarShortcut({
				key: 'b',
				ctrlKey: false,
				metaKey: true,
				altKey: false,
				shiftKey: false,
				repeat: false,
			}),
		).toBe(true);
		expect(
			isAppSidebarShortcut({
				key: 'b',
				ctrlKey: true,
				metaKey: false,
				altKey: true,
				shiftKey: false,
				repeat: false,
			}),
		).toBe(false);
		expect(
			isAppSidebarShortcut({
				key: 'b',
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: true,
				repeat: false,
			}),
		).toBe(false);
		expect(
			isAppSidebarShortcut(
				{
					key: 'b',
					ctrlKey: true,
					metaKey: false,
					altKey: false,
					shiftKey: false,
					repeat: false,
				},
				true,
			),
		).toBe(false);
	});
});
