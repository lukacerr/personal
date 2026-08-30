// @vitest-environment happy-dom
import {
	clearAgentLocal,
	draftThreadTitle,
	findAdjacentAnchor,
	formatDuration,
	formatTokenCount,
	isAgentRailShortcut,
	isNewChatShortcut,
	isNextUserMessageShortcut,
	isPinnedToBottom,
	isPreviousUserMessageShortcut,
	isThreadEndShortcut,
	isThreadFindShortcut,
	isThreadStartShortcut,
	messagesReferenceFiles,
	messageText,
	readAgentLocal,
	reasoningForModel,
	rememberThread,
	restoreSelection,
	type SelectionCatalog,
	storageReadFile,
	storageSearchFiles,
	storageSearchLabel,
	tavilyQuery,
	tavilySources,
	temperatureForModel,
	tokensPerSecond,
} from '@web/lib/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * This happy-dom build exposes no `localStorage` — the same gap
 * auth-refresh.test.ts documents — so the mirror talks to a memory stub.
 */
function createMemoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key),
		clear: () => data.clear(),
	};
}

vi.stubGlobal('localStorage', createMemoryStorage());

const catalog: SelectionCatalog = {
	models: [
		{
			id: 'claude-sonnet-5',
			reasoning: { levels: ['off', 'low', 'high'], default: 'high' },
			temperature: {
				min: 0,
				max: 1,
				step: 0.1,
				default: 0.5,
				reasoning: ['off', 'low'],
			},
		},
		{ id: 'qwen/qwen3.8-max', reasoning: { levels: [] } },
	],
	tools: [{ name: 'tavily' }],
};

beforeEach(() => {
	localStorage.clear();
});

describe('restoreSelection', () => {
	it('starts from the first model with the default tools', () => {
		expect(restoreSelection(catalog, undefined)).toEqual({
			model: 'claude-sonnet-5',
			reasoning: 'high',
			tools: ['tavily'],
			maxSteps: 5,
		});
	});

	it('falls back to the first model when the remembered one retired', () => {
		const restored = restoreSelection(catalog, {
			model: 'claude-legacy-1',
			reasoning: 'low',
			tools: ['tavily'],
			maxSteps: 10,
			temperature: 0.7,
		});
		expect(restored.model).toBe('claude-sonnet-5');
		expect(restored.tools).toEqual(['tavily']);
	});

	it('keeps a remembered level the model accepts', () => {
		expect(
			restoreSelection(catalog, {
				model: 'claude-sonnet-5',
				reasoning: 'off',
				tools: [],
			}).reasoning,
		).toBe('off');
	});

	it('replaces a level the model does not accept with its default', () => {
		expect(
			restoreSelection(catalog, {
				model: 'claude-sonnet-5',
				reasoning: 'xhigh',
				tools: [],
			}).reasoning,
		).toBe('high');
	});

	it('drops reasoning entirely for models without a knob', () => {
		const restored = restoreSelection(catalog, {
			model: 'qwen/qwen3.8-max',
			reasoning: 'high',
			tools: ['tavily'],
			maxSteps: 5,
			temperature: 0.7,
		});
		expect(restored.model).toBe('qwen/qwen3.8-max');
		expect('reasoning' in restored).toBe(false);
		expect('temperature' in restored).toBe(false);
	});

	it('filters tools the catalog does not know', () => {
		expect(
			restoreSelection(catalog, {
				model: 'claude-sonnet-5',
				tools: ['tavily', 'retired-tool'],
			}).tools,
		).toEqual(['tavily']);
	});

	it('restores any positive integer step count when the capability applies', () => {
		expect(
			restoreSelection(catalog, {
				model: 'claude-sonnet-5',
				reasoning: 'low',
				tools: [],
				maxSteps: 1_000,
				temperature: 0.7,
			}),
		).toEqual({
			model: 'claude-sonnet-5',
			reasoning: 'low',
			tools: [],
			maxSteps: 1_000,
			temperature: 0.7,
		});
		expect(
			restoreSelection(catalog, {
				model: 'claude-sonnet-5',
				reasoning: 'high',
				tools: [],
				maxSteps: 99,
				temperature: 0.7,
			}),
		).toEqual({
			model: 'claude-sonnet-5',
			reasoning: 'high',
			tools: [],
			maxSteps: 99,
		});
	});
});

describe('reasoningForModel', () => {
	const model = catalog.models[0];
	if (!model) throw new Error('fixture lost its model');

	it('keeps a supported level and defaults an unsupported one', () => {
		expect(reasoningForModel(model, 'low')).toBe('low');
		expect(reasoningForModel(model, 'max')).toBe('high');
		expect(reasoningForModel(model, undefined)).toBe('high');
	});
});

describe('temperatureForModel', () => {
	const model = catalog.models[0];
	if (!model) throw new Error('fixture lost its model');

	it('preserves a valid custom value only for applicable reasoning', () => {
		expect(temperatureForModel(model, 'low', 0.7)).toBe(0.7);
		expect(temperatureForModel(model, 'high', 0.7)).toBeUndefined();
		expect(temperatureForModel(model, 'low', 2)).toBeUndefined();
	});
});

describe('the local mirror', () => {
	it('keeps legacy selection readable while only writing thread state', () => {
		localStorage.setItem(
			'personal-agent:v1',
			JSON.stringify({
				selection: {
					model: 'claude-sonnet-5',
					tools: ['tavily'],
					maxSteps: 10,
					temperature: 0.4,
				},
			}),
		);
		rememberThread('t1');
		expect(readAgentLocal()).toEqual({
			thread: 't1',
			selection: {
				model: 'claude-sonnet-5',
				tools: ['tavily'],
				maxSteps: 10,
				temperature: 0.4,
			},
		});
		rememberThread(undefined);
		expect(readAgentLocal().thread).toBeUndefined();
	});

	it('reads corrupt or foreign storage as empty', () => {
		localStorage.setItem('personal-agent:v1', '{nope');
		expect(readAgentLocal()).toEqual({});
		localStorage.setItem(
			'personal-agent:v1',
			JSON.stringify({ thread: 7, selection: { model: 1, tools: 'x' } }),
		);
		expect(readAgentLocal()).toEqual({});
	});

	it('clears both thread restoration and shared settings on sign-out', () => {
		localStorage.setItem('personal-agent:v1', JSON.stringify({ thread: 't1' }));
		localStorage.setItem(
			'personal-agent-settings:v1',
			JSON.stringify({
				version: 1,
				selection: { model: 'model-a', tools: [], maxSteps: 5 },
			}),
		);

		clearAgentLocal();

		expect(localStorage.getItem('personal-agent:v1')).toBeNull();
		expect(localStorage.getItem('personal-agent-settings:v1')).toBeNull();
	});
});

describe('view helpers', () => {
	it('derives the draft title exactly like the server', () => {
		expect(draftThreadTitle('  Hola\n\n  mundo  ')).toBe('Hola mundo');
		expect(draftThreadTitle('x'.repeat(200))).toHaveLength(80);
		expect(draftThreadTitle('   ')).toBe('New chat');
	});

	it('claims the bare letter n outside editable targets only', () => {
		const base = {
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			repeat: false,
			key: 'n',
			target: null,
		};
		expect(isNewChatShortcut(base)).toBe(true);
		expect(isNewChatShortcut({ ...base, ctrlKey: true })).toBe(false);
		expect(isNewChatShortcut({ ...base, repeat: true })).toBe(false);
		expect(isNewChatShortcut({ ...base, key: 'a' })).toBe(false);
		const input = document.createElement('input');
		expect(isNewChatShortcut({ ...base, target: input })).toBe(false);
	});

	it('folds this screen’s rail with Ctrl+Alt+B, never with plain Ctrl+B', () => {
		const base = {
			altKey: true,
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			repeat: false,
			key: 'b',
			target: null,
		};
		expect(isAgentRailShortcut(base)).toBe(true);
		// The shell's own sidebar shortcut requires Alt to be up, so the two can
		// never fire together.
		expect(isAgentRailShortcut({ ...base, altKey: false })).toBe(false);
		expect(isAgentRailShortcut({ ...base, shiftKey: true })).toBe(false);
		expect(isAgentRailShortcut({ ...base, key: 'n' })).toBe(false);
	});

	it('claims Ctrl+F for the thread finder, even from the composer', () => {
		const base = {
			altKey: false,
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			repeat: false,
			key: 'f',
			target: null,
		};
		expect(isThreadFindShortcut(base)).toBe(true);
		// Searching while writing is the common case, so the field does not block it.
		const textarea = document.createElement('textarea');
		expect(isThreadFindShortcut({ ...base, target: textarea })).toBe(true);
		expect(isThreadFindShortcut({ ...base, shiftKey: true })).toBe(false);
		expect(isThreadFindShortcut({ ...base, ctrlKey: false })).toBe(false);
	});

	it('separates walking the questions from jumping to the thread ends', () => {
		const base = {
			altKey: false,
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			repeat: false,
			key: 'ArrowUp',
			target: null,
		};
		expect(isPreviousUserMessageShortcut(base)).toBe(true);
		expect(isThreadStartShortcut(base)).toBe(false);

		const shifted = { ...base, shiftKey: true };
		expect(isThreadStartShortcut(shifted)).toBe(true);
		// The plain predicate requires shift up, so one press is never both.
		expect(isPreviousUserMessageShortcut(shifted)).toBe(false);

		const down = { ...base, key: 'ArrowDown' };
		expect(isNextUserMessageShortcut(down)).toBe(true);
		expect(isThreadEndShortcut({ ...down, shiftKey: true })).toBe(true);

		// Held keys keep travelling, but a text field owns Ctrl+Arrow.
		expect(isPreviousUserMessageShortcut({ ...base, repeat: true })).toBe(true);
		const input = document.createElement('input');
		expect(isPreviousUserMessageShortcut({ ...base, target: input })).toBe(
			false,
		);
	});

	it('stays pinned near the bottom and lets go further up', () => {
		expect(isPinnedToBottom(1000, 800, 1850)).toBe(true);
		expect(isPinnedToBottom(100, 800, 1850)).toBe(false);
		// A document shorter than the viewport is always at the bottom.
		expect(isPinnedToBottom(0, 800, 500)).toBe(true);
	});
});

describe('question-to-question navigation', () => {
	const anchors = [0, 500, 1200, 1800];

	it('walks to the next and previous question', () => {
		expect(findAdjacentAnchor(anchors, 0, 'next')).toBe(500);
		expect(findAdjacentAnchor(anchors, 500, 'next')).toBe(1200);
		expect(findAdjacentAnchor(anchors, 1200, 'previous')).toBe(500);
	});

	it('never returns the anchor already in view, so a press always moves', () => {
		// Exactly on an anchor: the slack keeps it from answering with itself.
		expect(findAdjacentAnchor(anchors, 500, 'previous')).toBe(0);
		expect(findAdjacentAnchor(anchors, 1800, 'next')).toBeUndefined();
		expect(findAdjacentAnchor(anchors, 0, 'previous')).toBeUndefined();
		expect(findAdjacentAnchor([], 0, 'next')).toBeUndefined();
	});
});

describe('turn stats', () => {
	it('derives throughput only when both numbers support it', () => {
		expect(tokensPerSecond(120, 2000)).toBeCloseTo(60);
		expect(tokensPerSecond(0, 2000)).toBeUndefined();
		expect(tokensPerSecond(120, 0)).toBeUndefined();
		expect(tokensPerSecond(undefined, 2000)).toBeUndefined();
	});

	it('formats durations and token counts compactly', () => {
		expect(formatDuration(7)).toBe('7 ms');
		expect(formatDuration(1234)).toBe('1.23 s');
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatTokenCount(1692)).toBe('1692 tokens');
		expect(formatTokenCount(24_500)).toBe('24.5k tokens');
		expect(formatTokenCount(undefined)).toBeUndefined();
	});
});

describe('messageText', () => {
	it('joins the text parts and ignores everything else', () => {
		expect(
			messageText([
				{ type: 'text', text: 'primero' },
				{ type: 'reasoning', text: 'no va al portapapeles' },
				{ type: 'tool-tavily', output: {} },
				{ type: 'text', text: 'segundo' },
			]),
		).toBe('primero\n\nsegundo');
		expect(messageText([])).toBe('');
		expect(messageText([null, 7, 'x'])).toBe('');
	});
});

describe('tavily part guards', () => {
	it('reads the query and the sources from well-formed parts', () => {
		expect(tavilyQuery({ query: 'bun runtime' })).toBe('bun runtime');
		expect(
			tavilySources({
				results: [
					{ title: 'Bun', url: 'https://bun.sh', content: 'x', score: 1 },
				],
			}),
		).toEqual([{ title: 'Bun', url: 'https://bun.sh' }]);
	});

	it('renders malformed shapes as nothing instead of crashing', () => {
		expect(tavilyQuery(undefined)).toBeUndefined();
		expect(tavilyQuery({ query: 7 })).toBeUndefined();
		expect(tavilySources(undefined)).toEqual([]);
		expect(tavilySources({ results: 'nope' })).toEqual([]);
		expect(tavilySources({ results: [{ title: 7, url: 'x' }] })).toEqual([]);
	});
});

describe('storage part guards', () => {
	it('reads the search scope and its results from well-formed parts', () => {
		expect(storageSearchLabel({ query: 'invoice' })).toBe('invoice');
		expect(storageSearchLabel({ folder: 'Agent' })).toBe('Agent');
		expect(storageSearchLabel({ query: 'a', folder: 'b' })).toBe('a');
		expect(
			storageSearchFiles({
				files: [
					{
						fileId: 'id-1',
						name: 'invoice.pdf',
						folder: null,
						mediaType: 'application/pdf',
						size: 10,
						createdAt: 0,
					},
				],
				hasMore: false,
			}),
		).toEqual([{ fileId: 'id-1', name: 'invoice.pdf' }]);
	});

	it('reads the read tool output from a well-formed part', () => {
		expect(
			storageReadFile({
				fileId: 'id-1',
				name: 'report.pdf',
				mediaType: 'application/pdf',
				size: 1234,
				kind: 'pdf',
				converted: true,
			}),
		).toEqual({
			fileId: 'id-1',
			name: 'report.pdf',
			mediaType: 'application/pdf',
			size: 1234,
		});
	});

	it('renders malformed shapes as nothing instead of crashing', () => {
		expect(storageSearchLabel(undefined)).toBeUndefined();
		expect(storageSearchLabel({ query: 7 })).toBeUndefined();
		expect(storageSearchFiles(undefined)).toEqual([]);
		expect(storageSearchFiles({ files: 'nope' })).toEqual([]);
		expect(storageSearchFiles({ files: [{ name: 7 }] })).toEqual([]);
		expect(storageReadFile(undefined)).toBeUndefined();
		expect(storageReadFile({ name: 7 })).toBeUndefined();
	});
});

describe('draftThreadTitle with file mentions', () => {
	it('strips mention tokens exactly like the server', () => {
		const id = '0198c9a2-1111-7000-8000-abcdefabcdef';
		expect(draftThreadTitle(`@f:${id} resumime esto`)).toBe('resumime esto');
		expect(draftThreadTitle(`@f:${id}`)).toBe('New chat');
	});
});

/**
 * The transcript resolves a mention or a read against the Storage index, and
 * on a fresh load nothing had asked for that index: every chip rendered as a
 * raw `@f:<uuid>` with no preview until an upload happened to populate it.
 */
describe('messagesReferenceFiles', () => {
	it('is true for a mention in text and for a read the agent performed', () => {
		const mentioned = [
			{
				parts: [
					{
						type: 'text',
						text: 'mirá @f:0198c9a2-1111-7000-8000-abcdefabcdef',
					},
				],
			},
		];
		const read = [
			{ parts: [{ type: 'tool-storageRead', state: 'output-available' }] },
		];
		expect(messagesReferenceFiles(mentioned)).toBe(true);
		expect(messagesReferenceFiles(read)).toBe(true);
	});

	it('is false for a thread that never touched a file', () => {
		expect(
			messagesReferenceFiles([
				{ parts: [{ type: 'text', text: 'hola, nada de archivos acá' }] },
				{ parts: [{ type: 'tool-tavily', state: 'output-available' }] },
			]),
		).toBe(false);
		expect(messagesReferenceFiles([])).toBe(false);
	});
});
