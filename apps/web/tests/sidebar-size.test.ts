// @vitest-environment happy-dom

import { clampSidebarWidth, isAppSidebarShortcut } from '@web/lib/sidebar-size';
import { describe, expect, it } from 'vitest';

const shortcut = (target: EventTarget | null = document.body) => ({
	key: 'b',
	ctrlKey: true,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	target,
});

describe('sidebar resizing', () => {
	it('keeps the width within comfortable desktop limits', () => {
		expect(clampSidebarWidth(180)).toBe(224);
		expect(clampSidebarWidth(300)).toBe(300);
		expect(clampSidebarWidth(500)).toBe(384);
	});

	it('only toggles the app sidebar for the exact Ctrl/Cmd+B shortcut', () => {
		expect(isAppSidebarShortcut(shortcut())).toBe(true);
		expect(
			isAppSidebarShortcut({ ...shortcut(), ctrlKey: false, metaKey: true }),
		).toBe(true);
		expect(isAppSidebarShortcut({ ...shortcut(), altKey: true })).toBe(false);
		expect(isAppSidebarShortcut({ ...shortcut(), shiftKey: true })).toBe(false);
		expect(isAppSidebarShortcut({ ...shortcut(), repeat: true })).toBe(false);
	});

	it('leaves Ctrl/Cmd+B to whatever editable target owns the caret', () => {
		const editor = document.createElement('div');
		editor.setAttribute('contenteditable', 'true');
		const paragraph = document.createElement('p');
		editor.append(paragraph);
		document.body.append(editor);

		// A collapsed caret still means bold: the editor applies it to whatever
		// gets typed next, so a selection check would miss the common case.
		expect(isAppSidebarShortcut(shortcut(editor))).toBe(false);
		expect(isAppSidebarShortcut(shortcut(paragraph))).toBe(false);
		expect(
			isAppSidebarShortcut(shortcut(document.createElement('input'))),
		).toBe(false);
		expect(
			isAppSidebarShortcut(shortcut(document.createElement('textarea'))),
		).toBe(false);

		editor.remove();
	});

	it('still toggles from targets that do not edit text', () => {
		expect(isAppSidebarShortcut(shortcut(document.body))).toBe(true);
		expect(
			isAppSidebarShortcut(shortcut(document.createElement('button'))),
		).toBe(true);
		expect(isAppSidebarShortcut(shortcut(null))).toBe(true);
	});
});
