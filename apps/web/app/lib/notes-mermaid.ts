import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
	type EditorState,
	Plugin,
	PluginKey,
	TextSelection,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { type MermaidRender, renderMermaid } from '@web/lib/mermaid';

/**
 * Both ids the code block's language list knows for mermaid. The input rule
 * normalizes `mmd` to `mermaid`, but a pasted or imported block keeps whatever
 * it came with.
 */
const MERMAID_LANGUAGES = new Set(['mermaid', 'mmd']);

/**
 * How long typing has to pause before the diagram redraws. Every keystroke in a
 * diagram passes through states that do not parse, and a redraw per key would
 * flash "invalid" between letters and burn a layout pass each time.
 */
export const MERMAID_PREVIEW_DEBOUNCE_MS = 300;

export const MERMAID_PREVIEW_CLASS = 'notes-mermaid-preview';

/** Zoom steps multiply; the range keeps a chart readable at both ends. */
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export type MermaidBlock = {
	/** The BlockNote block id, which is what keeps a preview attached across edits. */
	id: string;
	/** Document position right after the code block's content node. */
	pos: number;
	source: string;
};

/**
 * Every code block whose language is mermaid, with where its preview goes: the
 * position after the block content, inside the block container, so the drawing
 * sits under the source and travels with the block.
 */
export function collectMermaidBlocks(doc: PMNode): MermaidBlock[] {
	const blocks: MermaidBlock[] = [];
	doc.descendants((node, pos, parent) => {
		if (node.type.name !== 'codeBlock') return true;
		const id = parent?.attrs.id;
		if (!MERMAID_LANGUAGES.has(node.attrs.language) || typeof id !== 'string')
			return false;
		blocks.push({ id, pos: pos + node.nodeSize, source: node.textContent });
		return false;
	});
	return blocks;
}

/**
 * The mermaid block the selection sits in, if any. Editing means seeing the
 * source, so this is what flips a block into its code view while typing.
 */
export function selectedMermaidBlock(state: EditorState): string | undefined {
	const { selection } = state;
	const { $from } = selection;
	const selected = 'node' in selection ? (selection.node as PMNode) : undefined;
	const container =
		selected?.type.name === 'codeBlock'
			? $from.parent
			: $from.parent.type.name === 'codeBlock' && $from.depth > 0
				? $from.node($from.depth - 1)
				: undefined;
	const id = container?.attrs.id;
	return typeof id === 'string' ? id : undefined;
}

type MermaidRenderer = (source: string, id: string) => Promise<MermaidRender>;

type PreviewView = 'diagram' | 'code';

type PreviewEntry = {
	id: string;
	element: HTMLElement;
	diagram: HTMLElement;
	status: HTMLElement;
	toggle: HTMLButtonElement;
	/** What the user asked for; the caret and a missing drawing can override it. */
	mode: PreviewView;
	zoom: number;
	/** Undefined until the first sync: a fresh entry draws without waiting. */
	source?: string;
	timer?: ReturnType<typeof setTimeout>;
	/** Bumped per draw so a slow render cannot paint over a newer source. */
	generation: number;
	disposed: boolean;
};

type EntryActions = {
	toggle: (entry: PreviewEntry) => void;
	zoom: (entry: PreviewEntry, factor: number | null) => void;
};

function toolbarButton(label: string, text: string) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'notes-mermaid-button';
	button.setAttribute('aria-label', label);
	button.textContent = text;
	return button;
}

function createEntry(id: string, actions: EntryActions) {
	const element = document.createElement('div');
	element.className = MERMAID_PREVIEW_CLASS;
	element.dataset.state = 'rendering';
	element.dataset.view = 'code';
	const toolbar = document.createElement('div');
	toolbar.className = 'notes-mermaid-toolbar';
	const zoomOut = toolbarButton('Zoom out', '−');
	const zoomIn = toolbarButton('Zoom in', '+');
	const zoomReset = toolbarButton('Reset zoom', '1:1');
	const zoomGroup = document.createElement('div');
	zoomGroup.className = 'notes-mermaid-zoom';
	zoomGroup.append(zoomOut, zoomReset, zoomIn);
	const toggle = toolbarButton('Show code', 'Show code');
	toggle.classList.add('notes-mermaid-toggle');
	toolbar.append(zoomGroup, toggle);
	const diagram = document.createElement('div');
	diagram.className = 'notes-mermaid-diagram';
	diagram.setAttribute('role', 'img');
	diagram.setAttribute('aria-label', 'Mermaid diagram');
	const status = document.createElement('p');
	status.className = 'notes-mermaid-status';
	status.hidden = true;
	element.append(toolbar, diagram, status);
	const entry: PreviewEntry = {
		id,
		element,
		diagram,
		status,
		toggle,
		mode: 'diagram',
		zoom: 1,
		generation: 0,
		disposed: false,
	};
	toggle.addEventListener('click', () => actions.toggle(entry));
	zoomIn.addEventListener('click', () => actions.zoom(entry, ZOOM_STEP));
	zoomOut.addEventListener('click', () => actions.zoom(entry, 1 / ZOOM_STEP));
	zoomReset.addEventListener('click', () => actions.zoom(entry, null));
	return entry;
}

function paint(entry: PreviewEntry, result: MermaidRender) {
	if (result.kind === 'ok') {
		// Mermaid runs its output through DOMPurify under the strict security
		// level the shared instance is initialized with.
		entry.diagram.innerHTML = result.svg;
		entry.status.textContent = '';
		entry.status.hidden = true;
		entry.element.dataset.state = 'ready';
		applyZoom(entry);
		return;
	}
	// The last good drawing stays: mid-edit the source is broken more often
	// than not, and a blank box says less than the diagram plus the reason.
	const [firstLine = ''] = result.message.trim().split('\n');
	entry.status.textContent = firstLine
		? `Invalid diagram · ${firstLine}`
		: 'Invalid diagram';
	entry.status.hidden = false;
	entry.element.dataset.state = 'invalid';
}

/**
 * Mermaid sizes its SVG with `width="100%"` capped by a `max-width` equal to
 * the drawing's natural width, which is what makes a chart fit the note. Zoom
 * works on that real width rather than on a `transform`, because a transform
 * does not take part in layout and the container would never grow to scroll.
 * At 1:1 the inline sizing comes off and mermaid's own fit is back.
 */
function applyZoom(entry: PreviewEntry) {
	const svg = entry.diagram.querySelector('svg');
	if (!svg) return;
	// Mermaid's own cap is what fitting means; it is kept to be put back.
	svg.dataset.fitMaxWidth ??= svg.style.maxWidth;
	if (entry.zoom === 1) {
		svg.style.removeProperty('width');
		svg.style.removeProperty('height');
		svg.style.maxWidth = svg.dataset.fitMaxWidth;
		return;
	}
	const natural = naturalWidth(svg);
	if (natural === undefined) return;
	svg.style.maxWidth = 'none';
	svg.style.width = `${Math.round(natural * entry.zoom)}px`;
	svg.style.height = 'auto';
}

function naturalWidth(svg: SVGElement) {
	const viewBox = svg
		.getAttribute('viewBox')
		?.trim()
		.split(/[\s,]+/);
	const fromViewBox = viewBox?.[2] ? Number(viewBox[2]) : Number.NaN;
	if (Number.isFinite(fromViewBox) && fromViewBox > 0) return fromViewBox;
	const fromStyle = Number.parseFloat(svg.dataset.fitMaxWidth ?? '');
	return Number.isFinite(fromStyle) && fromStyle > 0 ? fromStyle : undefined;
}

/**
 * Owns the preview elements of one editor view. The decorations only place
 * them; this decides when each one redraws, paints the result and which of
 * source or drawing is on show.
 */
class PreviewRegistry {
	private readonly entries = new Map<string, PreviewEntry>();
	private renders = 0;
	private focused = false;
	private activeId: string | undefined;

	constructor(
		private readonly view: EditorView,
		private readonly render: MermaidRenderer,
	) {}

	element(id: string) {
		return this.entry(id).element;
	}

	sync(blocks: readonly MermaidBlock[], activeId: string | undefined) {
		this.activeId = activeId;
		const seen = new Set<string>();
		for (const block of blocks) {
			seen.add(block.id);
			const entry = this.entry(block.id);
			this.applyView(entry);
			if (entry.source === block.source) continue;
			const first = entry.source === undefined;
			entry.source = block.source;
			clearTimeout(entry.timer);
			if (first) void this.draw(entry);
			else
				entry.timer = setTimeout(
					() => void this.draw(entry),
					MERMAID_PREVIEW_DEBOUNCE_MS,
				);
		}
		for (const [id, entry] of this.entries) {
			if (seen.has(id)) continue;
			this.dispose(entry);
			this.entries.delete(id);
		}
	}

	setFocused(focused: boolean) {
		this.focused = focused;
		for (const entry of this.entries.values()) this.applyView(entry);
	}

	/**
	 * The plugin view is going away, but not necessarily the editor: ProseMirror
	 * recreates plugin views whenever the plugin list is reconfigured, while the
	 * widget elements already in the DOM stay put. Disposing the entries here
	 * left those elements stuck on "rendering" forever — an in-flight draw
	 * skipped its paint, and the replacement registry drew into elements that
	 * never entered the DOM. So only the pending redraws are cancelled, marked
	 * to draw again as soon as the next plugin view syncs.
	 */
	suspend() {
		for (const entry of this.entries.values()) {
			if (entry.timer === undefined) continue;
			clearTimeout(entry.timer);
			entry.timer = undefined;
			entry.source = undefined;
		}
	}

	private entry(id: string) {
		let entry = this.entries.get(id);
		if (!entry) {
			entry = createEntry(id, {
				toggle: (target) => this.toggle(target),
				zoom: (target, factor) => {
					target.zoom =
						factor === null
							? 1
							: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target.zoom * factor));
					applyZoom(target);
				},
			});
			this.entries.set(id, entry);
		}
		return entry;
	}

	private dispose(entry: PreviewEntry) {
		clearTimeout(entry.timer);
		entry.disposed = true;
	}

	private async draw(entry: PreviewEntry) {
		const source = entry.source ?? '';
		const generation = ++entry.generation;
		// Block ids are UUIDs and may start with a digit, which `#id` rejects.
		const result = await this.render(
			source,
			`mermaid-${entry.id}-${++this.renders}`,
		);
		if (entry.disposed || entry.generation !== generation) return;
		paint(entry, result);
		this.applyView(entry);
	}

	/**
	 * Source and drawing are never on screen together. The drawing shows when
	 * there is one, unless the user asked for the source or the caret is in the
	 * block: editing means seeing what is being edited.
	 */
	private applyView(entry: PreviewEntry) {
		const editing = this.focused && this.activeId === entry.id;
		const drawn = entry.diagram.childElementCount > 0;
		const view: PreviewView =
			drawn && entry.mode === 'diagram' && !editing ? 'diagram' : 'code';
		entry.element.dataset.view = view;
		entry.element.dataset.drawn = drawn ? 'true' : 'false';
		const label = view === 'diagram' ? 'Show code' : 'Show diagram';
		entry.toggle.textContent = label;
		entry.toggle.setAttribute('aria-label', label);
		entry.toggle.disabled = !drawn;
	}

	/** Flips what is on show and puts the caret where it makes sense to be. */
	private toggle(entry: PreviewEntry) {
		const { view } = this;
		if (entry.element.dataset.view === 'diagram') {
			entry.mode = 'code';
			this.applyView(entry);
			if (!view.editable) return;
			// The source is what they asked to see, so land the caret in it.
			const pos = codeStart(view.state.doc, entry.id);
			if (pos === undefined) return;
			view.dispatch(
				view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
			);
			view.focus();
			this.settleFocus();
			return;
		}
		entry.mode = 'diagram';
		// With the caret still inside, the source would stay on show.
		if (this.focused && this.activeId === entry.id) view.dom.blur();
		this.settleFocus();
		this.applyView(entry);
	}

	/**
	 * Moving focus by hand does not always come with its event: a window in the
	 * background gets no `focus`/`blur` at all. Reading the state directly after
	 * the move keeps the view honest either way.
	 */
	private settleFocus() {
		this.focused = this.view.hasFocus();
	}
}

/** Position of the first character of the code block with this container id. */
function codeStart(doc: PMNode, id: string): number | undefined {
	let start: number | undefined;
	doc.descendants((node, pos) => {
		if (start !== undefined) return false;
		if (node.attrs.id !== id) return true;
		if (node.firstChild?.type.name === 'codeBlock') start = pos + 2;
		return false;
	});
	return start;
}

type PluginState = { blocks: MermaidBlock[]; decorations: DecorationSet };

const pluginKey = new PluginKey<PluginState>('personalNoteMermaid');

/**
 * Draws a diagram under every mermaid code block, as a widget decoration keyed
 * by block id so the element survives edits to the source. One plugin instance
 * serves every editor built from the schema — history preview and editor mount
 * the same note side by side — so the elements are tracked per view, for as
 * long as the view lives: the WeakMap lets go of a registry with its view.
 */
export function mermaidPreviewPlugin(render: MermaidRenderer = renderMermaid) {
	const registries = new WeakMap<EditorView, PreviewRegistry>();
	const registryFor = (view: EditorView) => {
		let registry = registries.get(view);
		if (!registry) {
			registry = new PreviewRegistry(view, render);
			registries.set(view, registry);
		}
		return registry;
	};
	const build = (doc: PMNode): PluginState => {
		const blocks = collectMermaidBlocks(doc);
		const decorations = DecorationSet.create(
			doc,
			blocks.map((block) =>
				Decoration.widget(
					block.pos,
					(view) => registryFor(view).element(block.id),
					{
						key: `${MERMAID_PREVIEW_CLASS}:${block.id}`,
						ignoreSelection: true,
						// Clicks on the toolbar are the widget's, not the editor's.
						stopEvent: () => true,
					},
				),
			),
		);
		return { blocks, decorations };
	};
	return new Plugin<PluginState>({
		key: pluginKey,
		state: {
			init: (_, state) => build(state.doc),
			apply: (tr, prev) => (tr.docChanged ? build(tr.doc) : prev),
		},
		props: {
			decorations: (state) => pluginKey.getState(state)?.decorations,
			handleDOMEvents: {
				focus: (view) => {
					registryFor(view).setFocused(true);
					return false;
				},
				blur: (view) => {
					registryFor(view).setFocused(false);
					return false;
				},
			},
		},
		view: (view) => {
			const registry = registryFor(view);
			const sync = (current: EditorView) =>
				registry.sync(
					pluginKey.getState(current.state)?.blocks ?? [],
					selectedMermaidBlock(current.state),
				);
			registry.setFocused(view.hasFocus());
			sync(view);
			return { update: sync, destroy: () => registry.suspend() };
		},
	});
}

/** Rides on the code block spec, so every editor built from the schema gets it. */
export const NoteMermaidExtension = createExtension({
	key: 'personalNoteMermaid',
	prosemirrorPlugins: [mermaidPreviewPlugin()],
});
