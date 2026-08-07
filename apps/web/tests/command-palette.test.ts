import {
	consumeCommandPaletteHistory,
	isCommandPaletteHistoryEntry,
	isCommandPaletteShortcut,
	pushCommandPaletteHistory,
	shouldRestorePaletteFocus,
} from '@web/lib/command-palette';
import { describe, expect, it, vi } from 'vitest';

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

	it('restores focus when dismissed but not after navigation', () => {
		expect(shouldRestorePaletteFocus('dismiss')).toBe(true);
		expect(shouldRestorePaletteFocus('navigate')).toBe(false);
	});

	it('adds one transient history entry and consumes it on close', () => {
		const pushState = vi.fn();
		const back = vi.fn();
		const history = {
			state: { key: 'router' } as unknown,
			pushState,
			back,
		};

		expect(pushCommandPaletteHistory(history, '/notes?note=1')).toBe(true);
		expect(pushState).toHaveBeenCalledWith(
			expect.objectContaining({ key: 'router' }),
			'',
			'/notes?note=1',
		);
		const marker = pushState.mock.calls[0]?.[0];
		expect(isCommandPaletteHistoryEntry(marker)).toBe(true);

		history.state = marker;
		expect(pushCommandPaletteHistory(history, '/notes?note=1')).toBe(false);
		expect(pushState).toHaveBeenCalledTimes(1);
		expect(consumeCommandPaletteHistory(history)).toBe(true);
		expect(back).toHaveBeenCalledOnce();
	});
});
