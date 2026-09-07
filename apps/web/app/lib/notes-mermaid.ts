import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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

type MermaidRenderer = (source: string, id: string) => Promise<MermaidRender>;

type PreviewEntry = {
	id: string;
	element: HTMLElement;
	diagram: HTMLElement;
	status: HTMLElement;
	/** Undefined until the first sync: a fresh entry draws without waiting. */
	source?: string;
	timer?: ReturnType<typeof setTimeout>;
	/** Bumped per draw so a slow render cannot paint over a newer source. */
	generation: number;
	disposed: boolean;
};

function createEntry(id: string): PreviewEntry {
	const element = document.createElement('div');
	element.className = MERMAID_PREVIEW_CLASS;
	element.dataset.state = 'rendering';
	const diagram = document.createElement('div');
	diagram.className = 'notes-mermaid-diagram';
	diagram.setAttribute('role', 'img');
	diagram.setAttribute('aria-label', 'Mermaid diagram');
	const status = document.createElement('p');
	status.className = 'notes-mermaid-status';
	status.hidden = true;
	element.append(diagram, status);
	return { id, element, diagram, status, generation: 0, disposed: false };
}

function paint(entry: PreviewEntry, result: MermaidRender) {
	if (result.kind === 'ok') {
		// Mermaid runs its output through DOMPurify under the strict security
		// level the shared instance is initialized with.
		entry.diagram.innerHTML = result.svg;
		entry.status.textContent = '';
		entry.status.hidden = true;
		entry.element.dataset.state = 'ready';
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
 * Owns the preview elements of one editor view. The decorations only place
 * them; this decides when each one redraws and paints the result.
 */
class PreviewRegistry {
	private readonly entries = new Map<string, PreviewEntry>();
	private renders = 0;

	constructor(private readonly render: MermaidRenderer) {}

	element(id: string) {
		return this.entry(id).element;
	}

	sync(blocks: readonly MermaidBlock[]) {
		const seen = new Set<string>();
		for (const block of blocks) {
			seen.add(block.id);
			const entry = this.entry(block.id);
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
			entry = createEntry(id);
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
	}
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
			registry = new PreviewRegistry(render);
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
		},
		view: (view) => {
			const registry = registryFor(view);
			const sync = (current: EditorView) =>
				registry.sync(pluginKey.getState(current.state)?.blocks ?? []);
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
