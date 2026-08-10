import { codeBlockOptions } from '@blocknote/code-block';
import {
	BlockNoteSchema,
	createCodeBlockSpec,
	defaultBlockSpecs,
	defaultInlineContentSpecs,
} from '@blocknote/core';
import { storedFileBlock } from '@web/components/notes/note-file';
import { equationBlock, latexInline } from '@web/components/notes/note-math';

/**
 * BlockNote ships the highlighting plugin but leaves it inert: its default code
 * block is `createCodeBlockSpec()` with no highlighter and no language list, so
 * it renders plain text and hides its language picker. Passing the official
 * Shiki options turns both on, and the languages load lazily on first use.
 */
export const notesSchema = BlockNoteSchema.create({
	blockSpecs: {
		...defaultBlockSpecs,
		codeBlock: createCodeBlockSpec(codeBlockOptions),
		equation: equationBlock(),
		// Registered under its own key rather than over BlockNote's `file`, whose
		// built-in block stores a URL in the document.
		storedFile: storedFileBlock(),
	},
	inlineContentSpecs: { ...defaultInlineContentSpecs, latex: latexInline },
});

/**
 * The document shape Notes stores, reads and diffs. Everything downstream types
 * against these instead of BlockNote's defaults, or a note holding an equation
 * only typechecks behind an assertion that hides the real contract.
 */
export type NoteBlock = typeof notesSchema.Block;
export type NotesEditor = typeof notesSchema.BlockNoteEditor;
