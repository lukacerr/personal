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
import { renderLatex } from '@web/lib/notes-math';
import type { NotesEditor } from '@web/lib/notes-schema';
import { SigmaIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MATH_MENU_GROUP = 'Math';

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
	onCommit,
	onCancel,
}: {
	value: string;
	onCommit: (latex: string) => void;
	onCancel: () => void;
}) {
	const [latex, setLatex] = useState(value);
	const input = useRef<HTMLInputElement>(null);
	const ignoreBlur = useRef(false);
	useEffect(() => input.current?.focus(), []);
	return (
		<Input
			ref={input}
			value={latex}
			onChange={(event) => setLatex(event.target.value)}
			onBlur={() => {
				if (!ignoreBlur.current) onCommit(latex);
			}}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					ignoreBlur.current = true;
					onCancel();
				}
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					onCommit(latex);
				}
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
	onUpdate,
}: {
	latex: string;
	editable: boolean;
	onUpdate: (latex: string) => void;
}) {
	// A freshly inserted equation is empty, so it opens ready to be typed into
	// instead of leaving a placeholder the user has to discover and click.
	const [open, setOpen] = useState(editable && !latex);
	const commit = (nextLatex: string) => {
		onUpdate(nextLatex);
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className="inline rounded-sm px-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="Edit inline equation"
			>
				<LatexOutput latex={latex} displayMode={false} />
			</PopoverTrigger>
			<PopoverContent>
				<PopoverHeader>
					<PopoverTitle>Inline equation</PopoverTitle>
					<PopoverDescription>
						Enter LaTeX, then press Enter.
					</PopoverDescription>
				</PopoverHeader>
				<LatexInput
					value={latex}
					onCommit={commit}
					onCancel={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}

export const equationBlock = createReactBlockSpec(
	{
		type: 'equation',
		propSchema: { latex: { default: '' } },
		content: 'none',
	},
	{
		render: ({ block, editor }) => {
			const [editing, setEditing] = useState(false);
			const update = (latex: string) => {
				editor.updateBlock(block, { props: { latex } });
				setEditing(false);
			};
			// An empty equation has nothing to render, so it shows its input until it
			// holds something. A read-only preview keeps the placeholder instead.
			const editable = editor.isEditable;
			return (
				<div className="my-1 w-full rounded-xl border border-transparent px-3 py-1 hover:border-border">
					{editable && (editing || !block.props.latex) ? (
						<LatexInput
							value={block.props.latex}
							onCommit={update}
							onCancel={() => setEditing(false)}
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
		type: 'latex',
		propSchema: { latex: { default: '' } },
		content: 'none',
	},
	{
		render: ({ inlineContent, updateInlineContent, editor }) => (
			<InlineLatex
				latex={inlineContent.props.latex}
				editable={editor.isEditable}
				onUpdate={(latex) =>
					updateInlineContent({ type: 'latex', props: { latex } })
				}
			/>
		),
	},
);

type MathEditor = Pick<
	NotesEditor,
	'getTextCursorPosition' | 'insertInlineContent' | 'updateBlock'
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
			onItemClick: () =>
				editor.updateBlock(editor.getTextCursorPosition().block, {
					type: 'equation',
					props: { latex: '' },
				}),
		},
		{
			title: 'Inline equation',
			subtext: 'Insert an equation in text',
			group: MATH_MENU_GROUP,
			icon: <SigmaIcon />,
			onItemClick: () =>
				editor.insertInlineContent([{ type: 'latex', props: { latex: '' } }]),
		},
	];
}
