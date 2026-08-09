import {
	createReactBlockSpec,
	createReactInlineContentSpec,
	type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { Input } from '@web/components/ui/input';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import {
	blockText,
	discardEquationBlock,
	type EquationEditor,
	equationEditorAnchor,
	focusBesideEquationBlock,
	focusBesideInlineEquation,
	OPEN_EQUATION_EVENT,
	removeInlineEquation,
} from '@web/lib/notes-editor';
import {
	EQUATION_BLOCK_TYPE,
	equationExitSide,
	LATEX_INLINE_TYPE,
	type MathSide,
	opensDisplayEquation,
	renderLatex,
} from '@web/lib/notes-math';
import type { NotesEditor } from '@web/lib/notes-schema';
import { SigmaIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MATH_MENU_GROUP = 'Math';

/** What the slash menu leaves in the block once it has removed its query. */
const MATH_MENU_TRIGGER = '/';

/**
 * Opens the LaTeX input when the editor asks this node view to take the caret,
 * and reports which side the caret came from so leaving can return it there.
 */
function useEquationOpenRequest(
	anchor: { current: HTMLElement | null },
	open: (origin: MathSide) => void,
) {
	const onOpen = useRef(open);
	onOpen.current = open;
	useEffect(() => {
		const element = anchor.current;
		if (!element) return;
		const handleOpen = (event: Event) =>
			onOpen.current((event as CustomEvent<MathSide>).detail);
		element.addEventListener(OPEN_EQUATION_EVENT, handleOpen);
		return () => element.removeEventListener(OPEN_EQUATION_EVENT, handleOpen);
	}, [anchor]);
}

function LatexOutput({
	latex,
	displayMode,
}: {
	latex: string;
	displayMode: boolean;
}) {
	const rendered = renderLatex(latex, displayMode);
	if (rendered.kind === 'empty')
		return (
			<span className="text-sm text-muted-foreground">Empty equation</span>
		);
	if (rendered.kind === 'invalid')
		return <span className="text-sm text-destructive">Invalid LaTeX</span>;
	// KaTeX escapes its TeX input before producing this trusted markup.
	// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX emits the accessible MathML and visual HTML together.
	return <span dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

function LatexInput({
	value,
	displayMode,
	origin,
	onCommit,
	onExit,
}: {
	value: string;
	displayMode: boolean;
	origin: MathSide;
	/** Clicking away keeps the LaTeX without claiming the caret. */
	onCommit: (latex: string) => void;
	onExit: (latex: string, side: MathSide) => void;
}) {
	const [latex, setLatex] = useState(value);
	const input = useRef<HTMLInputElement>(null);
	const exited = useRef(false);
	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.focus();
		// The caret carries on from the side it came in through. Landing at the
		// far end instead would send the next arrow key back out of the equation
		// the way it just came, and arrowing across a line would never reach the
		// LaTeX in between.
		const caret = origin === 'before' ? 0 : element.value.length;
		element.setSelectionRange(caret, caret);
	}, [origin]);
	return (
		<Input
			ref={input}
			value={latex}
			onChange={(event) => setLatex(event.target.value)}
			onBlur={() => {
				if (!exited.current) onCommit(latex);
			}}
			onKeyDown={(event) => {
				const side = equationExitSide({
					key: event.key,
					shiftKey: event.shiftKey,
					displayMode,
					caretStart: event.currentTarget.selectionStart ?? 0,
					caretEnd: event.currentTarget.selectionEnd ?? 0,
					length: latex.length,
					origin,
				});
				if (!side) return;
				event.preventDefault();
				// An overlay would otherwise treat Escape as its own and hand focus
				// back to whatever opened it, undoing the caret this exit just placed.
				event.stopPropagation();
				exited.current = true;
				onExit(latex, side);
			}}
			placeholder="e = mc^2"
			aria-label="LaTeX equation"
			className="font-mono"
		/>
	);
}

function InlineLatex({
	latex,
	editable,
	editor,
	onUpdate,
}: {
	latex: string;
	editable: boolean;
	editor: EquationEditor;
	onUpdate: (latex: string) => void;
}) {
	// A freshly inserted equation is empty, so it opens ready to be typed into
	// instead of leaving a placeholder the user has to discover and click.
	const [open, setOpen] = useState(editable && !latex);
	// Clicking in says nothing about where the caret was, and after the equation
	// is the side a reader is heading towards.
	const [origin, setOrigin] = useState<MathSide>('after');
	const trigger = useRef<HTMLButtonElement>(null);
	useEquationOpenRequest(trigger, (from) => {
		setOrigin(from);
		setOpen(true);
	});

	const exit = (nextLatex: string, side: MathSide) => {
		// Read before the update, because committing re-renders this node view.
		const anchor = trigger.current;
		setOpen(false);
		if (!anchor) return;
		if (!nextLatex.trim()) {
			removeInlineEquation(editor, anchor);
			return;
		}
		onUpdate(nextLatex);
		focusBesideInlineEquation(editor, anchor, side);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				ref={trigger}
				{...equationEditorAnchor}
				className="inline rounded-sm px-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="Edit inline equation"
			>
				<LatexOutput latex={latex} displayMode={false} />
			</PopoverTrigger>
			{/* The caret is placed by the exit itself, so the popover must not pull
			    focus back to its trigger on the way out. */}
			<PopoverContent finalFocus={false}>
				<PopoverHeader>
					<PopoverTitle>Inline equation</PopoverTitle>
					<PopoverDescription>
						Enter LaTeX, then press Enter or an arrow key to leave.
					</PopoverDescription>
				</PopoverHeader>
				<LatexInput
					value={latex}
					displayMode={false}
					origin={origin}
					onCommit={(nextLatex) => {
						onUpdate(nextLatex);
						setOpen(false);
					}}
					onExit={exit}
				/>
			</PopoverContent>
		</Popover>
	);
}

export const equationBlock = createReactBlockSpec(
	{
		type: EQUATION_BLOCK_TYPE,
		propSchema: { latex: { default: '' } },
		content: 'none',
	},
	{
		render: ({ block, editor }) => {
			const [editing, setEditing] = useState(false);
			const [origin, setOrigin] = useState<MathSide>('after');
			const anchor = useRef<HTMLDivElement>(null);
			useEquationOpenRequest(anchor, (from) => {
				setOrigin(from);
				setEditing(true);
			});
			const update = (latex: string) => {
				editor.updateBlock(block, { props: { latex } });
				setEditing(false);
			};
			const exit = (latex: string, side: MathSide) => {
				setEditing(false);
				// An equation left empty goes back to the paragraph it replaced,
				// rather than staying in the note as a block with nothing to show.
				if (!latex.trim()) {
					discardEquationBlock(editor, block.id);
					return;
				}
				editor.updateBlock(block, { props: { latex } });
				focusBesideEquationBlock(editor, block.id, side);
			};
			// An empty equation has nothing to render, so it shows its input until it
			// holds something. A read-only preview keeps the placeholder instead.
			const editable = editor.isEditable;
			return (
				<div
					ref={anchor}
					{...equationEditorAnchor}
					className="my-1 w-full rounded-xl border border-transparent px-3 py-1 hover:border-border"
				>
					{editable && (editing || !block.props.latex) ? (
						<LatexInput
							value={block.props.latex}
							displayMode
							origin={origin}
							onCommit={update}
							onExit={exit}
						/>
					) : (
						<button
							type="button"
							onClick={() => setEditing(true)}
							// Centred by KaTeX's own display styling rather than by a flex
							// container, so an equation wider than the note scrolls instead
							// of overflowing past its left edge.
							className="block min-h-8 w-full overflow-x-auto rounded-lg text-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							aria-label="Edit equation"
						>
							<LatexOutput latex={block.props.latex} displayMode />
						</button>
					)}
				</div>
			);
		},
	},
);

export const latexInline = createReactInlineContentSpec(
	{
		type: LATEX_INLINE_TYPE,
		propSchema: { latex: { default: '' } },
		content: 'none',
	},
	{
		render: ({ inlineContent, updateInlineContent, editor }) => (
			<InlineLatex
				latex={inlineContent.props.latex}
				editable={editor.isEditable}
				editor={editor}
				onUpdate={(latex) =>
					updateInlineContent({ type: LATEX_INLINE_TYPE, props: { latex } })
				}
			/>
		),
	},
);

type MathEditor = Pick<
	NotesEditor,
	| 'getTextCursorPosition'
	| 'insertBlocks'
	| 'insertInlineContent'
	| 'setTextCursorPosition'
	| 'updateBlock'
>;

export function mathSlashMenuItems(
	editor: MathEditor,
): DefaultReactSuggestionItem[] {
	return [
		{
			title: 'Equation',
			subtext: 'Insert a display equation',
			group: MATH_MENU_GROUP,
			icon: <SigmaIcon />,
			onItemClick: () => {
				const { block } = editor.getTextCursorPosition();
				const equation = {
					type: EQUATION_BLOCK_TYPE,
					props: { latex: '' },
				} as const;
				// The menu leaves its trigger in the block, and a display equation
				// replaces whatever block it lands on. Picking one from the middle of
				// a written line adds it below instead of erasing the line.
				if (opensDisplayEquation(blockText(block), MATH_MENU_TRIGGER)) {
					editor.updateBlock(block, equation);
					return;
				}
				const [inserted] = editor.insertBlocks([equation], block, 'after');
				if (inserted) editor.setTextCursorPosition(inserted);
			},
		},
		{
			title: 'Inline equation',
			subtext: 'Insert an equation in text',
			group: MATH_MENU_GROUP,
			icon: <SigmaIcon />,
			// Inline content is inserted at the cursor and destroys nothing.
			onItemClick: () =>
				editor.insertInlineContent([
					{ type: LATEX_INLINE_TYPE, props: { latex: '' } },
				]),
		},
	];
}
