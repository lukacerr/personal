import { createExtension, type PartialBlock } from '@blocknote/core';
import { Extension, InputRule, isNodeSelection } from '@tiptap/core';
import FindAndReplace from '@tiptap/extension-find-and-replace';
import { STORED_FILE_BLOCK_TYPE } from '@web/lib/notes-files';
import {
	DISPLAY_MATH_INPUT_RULE,
	EQUATION_BLOCK_TYPE,
	INLINE_MATH_INPUT_RULE,
	inlineEquationEntry,
	LATEX_INLINE_TYPE,
	type MathSide,
	opensDisplayEquation,
} from '@web/lib/notes-math';
import type { NoteBlock, NotesEditor } from '@web/lib/notes-schema';

export const NOTE_BLOCK_CLIPBOARD_TYPE =
	'application/x-personal-note-block+json';

/** Carries the side the caret came from, so backing out returns there. */
export const OPEN_EQUATION_EVENT = 'personal:open-equation';

const EQUATION_EDITOR_ATTRIBUTE = 'data-equation-editor';
const EQUATION_EDITOR_SELECTOR = `[${EQUATION_EDITOR_ATTRIBUTE}]`;

/**
 * Spread onto the element an equation node view listens on. The extension looks
 * the element up by the same attribute, so the two sides cannot drift apart.
 */
export const equationEditorAnchor = { [EQUATION_EDITOR_ATTRIBUTE]: '' };

type EquationView = NotesEditor['prosemirrorView'];

/**
 * What an equation node view needs from the editor it is handed.
 *
 * BlockNote narrows the schema generics of the editor it passes to a block or
 * inline spec down to that one type, so the full `NotesEditor` is not what
 * arrives there. Asking for the members actually used keeps both call sites
 * honest without an assertion that would claim a schema they do not have.
 */
export type EquationEditor = {
	prosemirrorView: EquationView;
	_tiptapEditor: NotesEditor['_tiptapEditor'];
	focus: () => void;
};

export type EquationBlockEditor = EquationEditor & {
	getPrevBlock: (id: string) => { id: string } | undefined;
	getNextBlock: (id: string) => { id: string } | undefined;
	insertBlocks: CallableFunction;
	setTextCursorPosition: CallableFunction;
	updateBlock: CallableFunction;
};

/**
 * Asks the equation rendered at `pos` to open its LaTeX input.
 *
 * The request travels as a DOM event on the node view instead of as editor
 * state because an inline equation carries no id to address it by, and turning
 * an element back into a position is ambiguous for an atom: a DOM position
 * inside one rounds to whichever side ProseMirror prefers, and the two answers
 * are a whole node apart. Asking ProseMirror which DOM it rendered for a
 * position has one answer, and the same question works in reverse.
 */
function requestEquationEditor(
	view: EquationView,
	pos: number,
	origin: MathSide,
) {
	const rendered = view.nodeDOM(pos);
	if (!(rendered instanceof HTMLElement)) return false;
	const target = rendered.matches(EQUATION_EDITOR_SELECTOR)
		? rendered
		: rendered.querySelector(EQUATION_EDITOR_SELECTOR);
	if (!target) return false;
	target.dispatchEvent(
		new CustomEvent<MathSide>(OPEN_EQUATION_EVENT, { detail: origin }),
	);
	return true;
}

/**
 * Finds the equation whose node view holds `root`, walking the note rather than
 * resolving the element to a position, for the reason above. A note is small
 * enough that scanning it on a single keystroke costs nothing.
 */
function findEquation(view: EquationView, root: HTMLElement) {
	let found: { pos: number; size: number } | undefined;
	view.state.doc.descendants((node, pos) => {
		if (found) return false;
		if (
			node.type.name !== LATEX_INLINE_TYPE &&
			node.type.name !== EQUATION_BLOCK_TYPE
		)
			return true;
		const rendered = view.nodeDOM(pos);
		if (rendered instanceof HTMLElement && rendered.contains(root))
			found = { pos, size: node.nodeSize };
		return false;
	});
	return found;
}

/** Puts the caret back in the text beside an inline equation. */
export function focusBesideInlineEquation(
	editor: EquationEditor,
	root: HTMLElement,
	side: MathSide,
) {
	const found = findEquation(editor.prosemirrorView, root);
	if (!found) {
		editor.focus();
		return;
	}
	editor._tiptapEditor.commands.focus(
		side === 'before' ? found.pos : found.pos + found.size,
	);
}

/** An inline equation left empty is not kept, and the caret takes its place. */
export function removeInlineEquation(
	editor: EquationEditor,
	root: HTMLElement,
) {
	const found = findEquation(editor.prosemirrorView, root);
	if (!found) {
		editor.focus();
		return;
	}
	editor._tiptapEditor
		.chain()
		.deleteRange({ from: found.pos, to: found.pos + found.size })
		.focus(found.pos)
		.run();
}

/**
 * Moves out of a display equation into text, adding the neighbouring block when
 * the equation sits at the edge of the note. An exit exists so that typing can
 * continue, so it has to land somewhere that accepts typing.
 */
export function focusBesideEquationBlock(
	editor: EquationBlockEditor,
	blockId: string,
	side: MathSide,
) {
	const neighbour =
		side === 'before'
			? editor.getPrevBlock(blockId)
			: editor.getNextBlock(blockId);
	const target =
		neighbour ?? editor.insertBlocks([{ type: 'paragraph' }], blockId, side)[0];
	if (target)
		editor.setTextCursorPosition(target, side === 'before' ? 'end' : 'start');
	editor.focus();
}

/** A display equation left empty goes back to being the empty paragraph it replaced. */
export function discardEquationBlock(
	editor: EquationBlockEditor,
	blockId: string,
) {
	editor.updateBlock(blockId, { type: 'paragraph' });
	editor.setTextCursorPosition(blockId, 'start');
	editor.focus();
}

export const NoteFindExtension = createExtension({
	key: 'personalNoteFind',
	tiptapExtensions: [
		FindAndReplace.configure({ injectCSS: false, searchDebounceMs: 0 }),
	],
});

/**
 * Typing dollars writes math, as in Notion and Obsidian, and the arrow keys
 * reach an equation instead of stepping over it.
 *
 * The two input rules need different mechanisms: BlockNote's own input rules
 * replace the whole block, which is what a display equation is, while an inline
 * equation replaces a range of text inside one and has to go through Tiptap.
 * Tiptap already declines to run input rules inside code, so a `$` in a code
 * block stays a `$`.
 *
 * Navigation splits the same way. An inline equation is an unselectable atom, so
 * nothing but the keypress that would cross it says the caret wants in, and the
 * arrow bindings answer that. A display equation is a selectable block that
 * ProseMirror already node-selects on its own, whichever key or click got there,
 * so watching for that selection covers every way in at once.
 */
export const NoteMathExtension = createExtension({
	key: 'personalNoteMath',
	tiptapExtensions: [
		Extension.create({
			name: 'personalInlineMath',
			addStorage() {
				return { previousFrom: 0 };
			},
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
			addKeyboardShortcuts() {
				const enterInlineEquation = (key: 'ArrowLeft' | 'ArrowRight') => () => {
					const { view } = this.editor;
					const { selection } = view.state;
					const origin = inlineEquationEntry({
						key,
						collapsed: selection.empty,
						nodeBefore: selection.$from.nodeBefore?.type.name,
						nodeAfter: selection.$from.nodeAfter?.type.name,
					});
					if (!origin) return false;
					const pos =
						origin === 'before'
							? selection.from
							: selection.from - (selection.$from.nodeBefore?.nodeSize ?? 0);
					return requestEquationEditor(view, pos, origin);
				};
				return {
					ArrowLeft: enterInlineEquation('ArrowLeft'),
					ArrowRight: enterInlineEquation('ArrowRight'),
				};
			},
			onSelectionUpdate() {
				const { selection } = this.editor.state;
				const { previousFrom } = this.storage;
				this.storage.previousFrom = selection.from;
				if (
					!isNodeSelection(selection) ||
					selection.node.type.name !== EQUATION_BLOCK_TYPE
				)
					return;
				// Coming from earlier in the note means the caret arrived on the
				// equation's leading side, and Escape has to give it back there.
				requestEquationEditor(
					this.editor.view,
					selection.from,
					previousFrom <= selection.from ? 'before' : 'after',
				);
			},
		}),
	],
	inputRules: [
		{
			find: DISPLAY_MATH_INPUT_RULE,
			replace: ({ editor }: { editor: NotesEditor }) =>
				opensDisplayEquation(
					blockText(editor.getTextCursorPosition().block),
					'$',
				)
					? { type: EQUATION_BLOCK_TYPE, props: { latex: '' } }
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

/** The text a block holds, which decides whether an equation may replace it. */
export function blockText(block: NoteBlock): string {
	const props = block.props as Record<string, unknown>;
	// A block with no inline content still has something to say when it is
	// copied: an equation is its LaTeX, and an attachment is its filename.
	const own =
		block.type === STORED_FILE_BLOCK_TYPE
			? props.name
			: (props.latex ?? undefined);
	const ownText = typeof own === 'string' ? own : inlineText(block.content);
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
