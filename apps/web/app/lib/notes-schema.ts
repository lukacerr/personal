import {
	BlockNoteSchema,
	defaultBlockSpecs,
	defaultInlineContentSpecs,
} from '@blocknote/core';
import { equationBlock, latexInline } from '@web/components/notes/note-math';

export const notesSchema = BlockNoteSchema.create({
	blockSpecs: { ...defaultBlockSpecs, equation: equationBlock() },
	inlineContentSpecs: { ...defaultInlineContentSpecs, latex: latexInline },
});

/**
 * The document shape Notes stores, reads and diffs. Everything downstream types
 * against these instead of BlockNote's defaults, or a note holding an equation
 * only typechecks behind an assertion that hides the real contract.
 */
export type NoteBlock = typeof notesSchema.Block;
export type NotesEditor = typeof notesSchema.BlockNoteEditor;
