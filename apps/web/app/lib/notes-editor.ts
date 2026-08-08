import { createExtension, type PartialBlock } from '@blocknote/core';
import { Extension, InputRule } from '@tiptap/core';
import FindAndReplace from '@tiptap/extension-find-and-replace';
import {
	DISPLAY_MATH_INPUT_RULE,
	INLINE_MATH_INPUT_RULE,
	opensDisplayEquation,
} from '@web/lib/notes-math';
import type { NoteBlock, NotesEditor } from '@web/lib/notes-schema';

export const NOTE_BLOCK_CLIPBOARD_TYPE =
	'application/x-personal-note-block+json';

export const NoteFindExtension = createExtension({
	key: 'personalNoteFind',
	tiptapExtensions: [
		FindAndReplace.configure({ injectCSS: false, searchDebounceMs: 0 }),
	],
});

/**
 * Typing dollars writes math, as in Notion and Obsidian.
 *
 * The two rules need different mechanisms: BlockNote's own input rules replace
 * the whole block, which is what a display equation is, while an inline
 * equation replaces a range of text inside one and has to go through Tiptap.
 * Tiptap already declines to run input rules inside code, so a `$` in a code
 * block stays a `$`.
 */
export const NoteMathExtension = createExtension({
	key: 'personalNoteMath',
	tiptapExtensions: [
		Extension.create({
			name: 'personalInlineMath',
			addInputRules() {
				return [
					new InputRule({
						find: INLINE_MATH_INPUT_RULE,
						handler: ({ state, range, match }) => {
							const latex = match[1];
							const latexNode = state.schema.nodes.latex;
							if (!latex || !latexNode) return null;
							state.tr.replaceWith(
								range.from,
								range.to,
								latexNode.create({ latex }),
							);
						},
					}),
				];
			},
		}),
	],
	inputRules: [
		{
			find: DISPLAY_MATH_INPUT_RULE,
			replace: ({ editor }: { editor: NotesEditor }) =>
				opensDisplayEquation(blockText(editor.getTextCursorPosition().block))
					? { type: 'equation', props: { latex: '' } }
					: undefined,
		},
	],
});

type BlockClipboard = Pick<DataTransfer, 'getData' | 'setData'>;

type BlockEditor = {
	document: readonly { id: string }[];
	getTextCursorPosition: () => { block: unknown };
	insertBlocks: CallableFunction;
	removeBlocks: CallableFunction;
	replaceBlocks: CallableFunction;
	setTextCursorPosition: CallableFunction;
};

type ClipboardPayload = {
	version: 1;
	block: NoteBlock;
};

/** Slash-menu entries whose uploads the Notes system does not support yet. */
export const unavailableSlashItems = new Set([
	'Audio',
	'File',
	'Image',
	'Video',
]);

export function centerCurrentFindResult(
	root: Pick<ParentNode, 'querySelector'>,
	schedule: (callback: () => void) => unknown = requestAnimationFrame,
) {
	schedule(() => {
		root
			.querySelector<HTMLElement>('.find-and-replace-result-current')
			?.scrollIntoView({ block: 'center', inline: 'nearest' });
	});
}

/**
 * The one source of truth for how a note reports its sync state.
 *
 * Both labels derive from this state instead of the compact one re-matching the
 * text of the full one: a renamed label used to silently fall through to
 * "Failed", which reported a healthy note as broken.
 */
export type NoteSyncState =
	| 'saving'
	| 'rejected'
	| 'failed'
	| 'pending'
	| 'offline'
	| 'draft'
	| 'synced';

const fullStatusLabels: Record<NoteSyncState, string> = {
	saving: 'Saving locally…',
	rejected: 'Server rejected this note',
	failed: 'Could not sync',
	pending: 'Sync pending',
	offline: 'Saved locally',
	draft: 'Unsaved draft',
	synced: 'Synced',
};

const compactStatusLabels: Record<NoteSyncState, string> = {
	saving: 'Saving…',
	rejected: 'Rejected',
	failed: 'Failed',
	pending: 'Pending',
	offline: 'Offline',
	draft: 'Draft',
	synced: 'Synced',
};

/** A rejection replaces the generic label with the reason the server gave. */
export function noteStatusLabel(
	state: NoteSyncState,
	reason: string | undefined,
) {
	return state === 'rejected' && reason ? reason : fullStatusLabels[state];
}

export function noteCompactStatusLabel(state: NoteSyncState) {
	return compactStatusLabels[state];
}

/** Turns free-form folder input into a stored path, treating a blank value as Root. */
export function normalizePath(path: string) {
	const normalized = path
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean)
		.join('/');
	return normalized || null;
}

/** Inline equations come back as the dollar shorthand that would retype them. */
function inlineText(content: NoteBlock['content']): string {
	if (!Array.isArray(content)) return '';
	return content
		.map((item) => {
			if ('text' in item) return item.text;
			const latex = (item as { props?: { latex?: unknown } }).props?.latex;
			return typeof latex === 'string' ? `$${latex}$` : '';
		})
		.join('');
}

function blockText(block: NoteBlock): string {
	const latex = (block.props as Record<string, unknown>).latex;
	const ownText = typeof latex === 'string' ? latex : inlineText(block.content);
	return [ownText, ...block.children.map(blockText)].filter(Boolean).join('\n');
}

function withoutIds(block: NoteBlock): PartialBlock {
	// Mapping a discriminated Block union loses the correlation between `type`,
	// props and content; the values themselves are copied from the same block.
	return {
		type: block.type,
		props: block.props,
		content: block.content,
		children: block.children.map(withoutIds),
	} as PartialBlock;
}

function readBlock(clipboard: Pick<BlockClipboard, 'getData'>) {
	const value = clipboard.getData(NOTE_BLOCK_CLIPBOARD_TYPE);
	if (!value) return undefined;
	try {
		const payload = JSON.parse(value) as ClipboardPayload;
		if (
			payload.version !== 1 ||
			!payload.block ||
			typeof payload.block.type !== 'string' ||
			!Array.isArray(payload.block.children)
		)
			return undefined;
		return payload.block;
	} catch {
		return undefined;
	}
}

export function copyCurrentBlock(
	editor: BlockEditor,
	clipboard: Pick<BlockClipboard, 'setData'>,
	hasTextSelection: boolean,
) {
	if (hasTextSelection) return false;
	const block = editor.getTextCursorPosition().block as NoteBlock;
	clipboard.setData(
		NOTE_BLOCK_CLIPBOARD_TYPE,
		JSON.stringify({ version: 1, block } satisfies ClipboardPayload),
	);
	clipboard.setData('text/plain', blockText(block));
	return true;
}

/**
 * Cutting a text selection is the browser's job; only a collapsed cursor means
 * the user is asking for the whole block.
 */
export function cutCurrentBlock(
	editor: BlockEditor,
	clipboard: Pick<BlockClipboard, 'setData'>,
	hasTextSelection: boolean,
) {
	if (!copyCurrentBlock(editor, clipboard, hasTextSelection)) return false;
	deleteCurrentBlock(editor);
	return true;
}

export function deleteCurrentBlock(editor: BlockEditor) {
	const block = editor.getTextCursorPosition().block as NoteBlock;
	if (editor.document.length === 1 && editor.document[0]?.id === block.id) {
		editor.replaceBlocks([block], [{ type: 'paragraph' }]);
		return;
	}
	editor.removeBlocks([block]);
}

export function pasteCopiedBlock(
	editor: BlockEditor,
	clipboard: Pick<BlockClipboard, 'getData'>,
) {
	const block = readBlock(clipboard);
	if (!block) return false;
	const current = editor.getTextCursorPosition().block as NoteBlock;
	const [inserted] = editor.insertBlocks([withoutIds(block)], current, 'after');
	if (inserted) editor.setTextCursorPosition(inserted, 'end');
	return true;
}
