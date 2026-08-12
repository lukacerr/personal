// @vitest-environment happy-dom

import { isAddPaymentShortcut } from '@web/lib/finance';
import { describe, expect, it } from 'vitest';

const press = (target: EventTarget | null = document.body) => ({
	key: 'a',
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	target,
});

describe('the add payment shortcut', () => {
	it('opens on a bare letter', () => {
		expect(isAddPaymentShortcut(press())).toBe(true);
		expect(isAddPaymentShortcut({ ...press(), key: 'A' })).toBe(true);
	});

	/**
	 * Ctrl/Cmd+A is select all, which is a shortcut people actually use, so the
	 * screen claims the bare letter and leaves every modified form alone.
	 */
	it('never claims a modified A', () => {
		expect(isAddPaymentShortcut({ ...press(), ctrlKey: true })).toBe(false);
		expect(isAddPaymentShortcut({ ...press(), metaKey: true })).toBe(false);
		expect(isAddPaymentShortcut({ ...press(), altKey: true })).toBe(false);
	});

	it('leaves the letter to whatever editable target owns the caret', () => {
		const editor = document.createElement('div');
		editor.setAttribute('contenteditable', 'true');
		const paragraph = document.createElement('p');
		editor.append(paragraph);
		document.body.append(editor);

		expect(isAddPaymentShortcut(press(editor))).toBe(false);
		expect(isAddPaymentShortcut(press(paragraph))).toBe(false);
		expect(isAddPaymentShortcut(press(document.createElement('input')))).toBe(
			false,
		);
		expect(
			isAddPaymentShortcut(press(document.createElement('textarea'))),
		).toBe(false);

		editor.remove();
	});

	it('ignores a held key and any other letter', () => {
		expect(isAddPaymentShortcut({ ...press(), repeat: true })).toBe(false);
		expect(isAddPaymentShortcut({ ...press(), key: 's' })).toBe(false);
	});

	it('still opens from targets that do not edit text', () => {
		expect(isAddPaymentShortcut(press(document.createElement('button')))).toBe(
			true,
		);
		expect(isAddPaymentShortcut(press(null))).toBe(true);
	});
});
