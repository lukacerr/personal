import { isCommandPaletteShortcut } from '@web/lib/command-palette';
import { describe, expect, it } from 'vitest';

describe('command palette shortcut', () => {
	it('accepts Ctrl+Space and Ctrl+Shift+Space without repeat', () => {
		expect(
			isCommandPaletteShortcut({
				key: ' ',
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				repeat: false,
			}),
		).toBe(true);
		expect(
			isCommandPaletteShortcut({
				key: ' ',
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: true,
				repeat: false,
			}),
		).toBe(true);
		expect(
			isCommandPaletteShortcut({
				key: ' ',
				ctrlKey: false,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				repeat: false,
			}),
		).toBe(false);
		expect(
			isCommandPaletteShortcut({
				key: ' ',
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				repeat: true,
			}),
		).toBe(false);
		expect(
			isCommandPaletteShortcut({
				key: ' ',
				ctrlKey: true,
				metaKey: false,
				altKey: true,
				shiftKey: true,
				repeat: false,
			}),
		).toBe(false);
	});
});
