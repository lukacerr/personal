// @vitest-environment happy-dom

import {
	isAddCredentialShortcut,
	isCopyCredentialShortcut,
	isToggleRevealShortcut,
} from '@web/lib/credentials';
import { describe, expect, it } from 'vitest';

const press = (key: string, target: EventTarget | null = document.body) => ({
	key,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	target,
});

describe('the credentials screen shortcuts', () => {
	it('toggle reveal answers a bare R, copy a bare C and create a bare A', () => {
		expect(isToggleRevealShortcut(press('r'))).toBe(true);
		expect(isToggleRevealShortcut(press('R'))).toBe(true);
		expect(isCopyCredentialShortcut(press('c'))).toBe(true);
		expect(isCopyCredentialShortcut(press('C'))).toBe(true);
		expect(isAddCredentialShortcut(press('a'))).toBe(true);
		expect(isAddCredentialShortcut(press('A'))).toBe(true);
	});

	/**
	 * Ctrl/Cmd+C is copy, Ctrl+R is reload and Ctrl/Cmd+A is select all —
	 * shortcuts people actually use — so the screen claims the bare letters and
	 * leaves every modified form alone.
	 */
	it('never claims a modified letter', () => {
		expect(isAddCredentialShortcut({ ...press('a'), ctrlKey: true })).toBe(
			false,
		);
		expect(isAddCredentialShortcut({ ...press('a'), metaKey: true })).toBe(
			false,
		);
		expect(isToggleRevealShortcut({ ...press('r'), ctrlKey: true })).toBe(
			false,
		);
		expect(isToggleRevealShortcut({ ...press('r'), metaKey: true })).toBe(
			false,
		);
		expect(isToggleRevealShortcut({ ...press('r'), altKey: true })).toBe(false);
		expect(isCopyCredentialShortcut({ ...press('c'), ctrlKey: true })).toBe(
			false,
		);
		expect(isCopyCredentialShortcut({ ...press('c'), metaKey: true })).toBe(
			false,
		);
		expect(isCopyCredentialShortcut({ ...press('c'), altKey: true })).toBe(
			false,
		);
	});

	it('leaves the letter to whatever editable target owns the caret', () => {
		const editor = document.createElement('div');
		editor.setAttribute('contenteditable', 'true');
		document.body.append(editor);

		expect(isToggleRevealShortcut(press('r', editor))).toBe(false);
		expect(
			isToggleRevealShortcut(press('r', document.createElement('input'))),
		).toBe(false);
		expect(isCopyCredentialShortcut(press('c', editor))).toBe(false);
		expect(
			isCopyCredentialShortcut(press('c', document.createElement('textarea'))),
		).toBe(false);

		editor.remove();
	});

	it('ignores a held key and any other letter', () => {
		expect(isToggleRevealShortcut({ ...press('r'), repeat: true })).toBe(false);
		expect(isToggleRevealShortcut(press('c'))).toBe(false);
		expect(isCopyCredentialShortcut({ ...press('c'), repeat: true })).toBe(
			false,
		);
		expect(isCopyCredentialShortcut(press('r'))).toBe(false);
		expect(isAddCredentialShortcut({ ...press('a'), repeat: true })).toBe(
			false,
		);
		expect(isAddCredentialShortcut(press('r'))).toBe(false);
	});

	it('create leaves the letter to an editable target too', () => {
		expect(
			isAddCredentialShortcut(press('a', document.createElement('input'))),
		).toBe(false);
	});

	it('still fires from targets that do not edit text', () => {
		expect(
			isToggleRevealShortcut(press('r', document.createElement('button'))),
		).toBe(true);
		expect(isCopyCredentialShortcut(press('c', null))).toBe(true);
	});
});
