import {
	AGENT_SETTINGS_KEY,
	legacySelectionSchema,
} from '@web/lib/agent-settings';
import {
	isBareLetterShortcut,
	isEditableTarget,
	type ShortcutEvent,
} from '@web/lib/keyboard';

export const AGENT_PATH = '/agent';

/** Mirror of the server's title rule, so the optimistic row matches the index. */
export const THREAD_TITLE_MAX = 80;

export const DEFAULT_AGENT_TOOLS = ['tavily'];

/**
 * What travels with every chat request. It is not a property of the thread —
 * a conversation can mix models turn by turn — so it lives in the composer
 * and, as a default for the next chat, in this device's local mirror.
 */
export type AgentSelection = {
	model: string;
	/** Absent for models whose catalog entry declares no levels. */
	reasoning?: string;
	tools: string[];
	maxSteps: number;
	/** Absent when this model/reasoning combination has no temperature knob. */
	temperature?: number;
};

/** The slice of the catalog the selection helpers read. */
export type SelectionCatalog = {
	models: readonly {
		id: string;
		reasoning: { levels: readonly string[]; default?: string };
		temperature?: {
			min: number;
			max: number;
			step: number;
			default: number;
			reasoning?: readonly string[];
		} | null;
	}[];
	tools: readonly { name: string }[];
};

/** `n` starts a chat; bare letters cost nothing outside a text field. */
export function isNewChatShortcut(event: ShortcutEvent) {
	return isBareLetterShortcut(event, 'n');
}

/**
 * Ctrl+Alt+B folds this screen's own thread rail — the same combination
 * Calendar uses for its side panel, and Notes for its tree: the modified
 * letter means "this screen's panel", while the shell's Ctrl/Cmd+B (whose
 * predicate requires Alt to be up) stays the app-wide sidebar. The two can
 * never fire together.
 */
export function isAgentRailShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		event.key.toLowerCase() === 'b'
	);
}

/**
 * Ctrl+F opens this screen's finder. It takes the browser's own find, the
 * same trade Notes already makes for its editor: a find inside a paginated
 * conversation searches the whole thread on the server, while the browser's
 * would only ever see the thirty turns that happen to be loaded.
 *
 * Unlike the arrow shortcuts below, this one fires even from the composer:
 * `f` is not a caret movement, and wanting to search while writing is the
 * common case.
 */
export function isThreadFindShortcut(event: ShortcutEvent) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		!event.repeat &&
		event.key.toLowerCase() === 'f'
	);
}

/**
 * Ctrl+Arrow walks the reader's own questions; adding Shift jumps to the ends
 * of the thread. Both are skipped inside a text field, where Ctrl+Arrow is a
 * caret movement the editor owns — the guard every shortcut in this app
 * shares. `repeat` is allowed on purpose: holding the key to travel a long
 * transcript is the point.
 */
function isArrowShortcut(
	event: ShortcutEvent & { key: string },
	key: 'ArrowUp' | 'ArrowDown',
	shift: boolean,
) {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		event.shiftKey === shift &&
		!isEditableTarget(event.target) &&
		event.key === key
	);
}

export const isPreviousUserMessageShortcut = (event: ShortcutEvent) =>
	isArrowShortcut(event, 'ArrowUp', false);

export const isNextUserMessageShortcut = (event: ShortcutEvent) =>
	isArrowShortcut(event, 'ArrowDown', false);

export const isThreadStartShortcut = (event: ShortcutEvent) =>
	isArrowShortcut(event, 'ArrowUp', true);

export const isThreadEndShortcut = (event: ShortcutEvent) =>
	isArrowShortcut(event, 'ArrowDown', true);

const AGENT_VIEW_KEY = 'personal-agent:v1';

type StoredAgentSelection = Omit<AgentSelection, 'maxSteps'> & {
	maxSteps?: number;
};

export type AgentLocalState = {
	thread?: string;
	selection?: StoredAgentSelection;
};

/** Storage is not to be trusted: corrupt JSON or a foreign shape reads empty. */
export function readAgentLocal(): AgentLocalState {
	try {
		const raw = localStorage.getItem(AGENT_VIEW_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const candidate = parsed as Record<string, unknown>;
		// The same schema the settings migration runs on these bytes, so the view
		// state and the migration cannot disagree about what is stored here.
		const stored = legacySelectionSchema.safeParse(candidate.selection);
		return {
			...(typeof candidate.thread === 'string'
				? { thread: candidate.thread }
				: {}),
			...(stored.success ? { selection: stored.data } : {}),
		};
	} catch {
		return {};
	}
}

function writeAgentLocal(next: AgentLocalState) {
	try {
		localStorage.setItem(AGENT_VIEW_KEY, JSON.stringify(next));
	} catch {
		// A blocked storage loses a view preference, never a conversation.
	}
}

export function rememberThread(id: string | undefined) {
	writeAgentLocal({ ...readAgentLocal(), thread: id });
}

export function clearAgentLocal() {
	try {
		localStorage.removeItem(AGENT_VIEW_KEY);
		localStorage.removeItem(AGENT_SETTINGS_KEY);
	} catch {
		// Nothing left to clear if storage itself is unavailable.
	}
}

type SelectionModel = SelectionCatalog['models'][number];

/** The current level if this model accepts it, else the model's own default. */
export function reasoningForModel(
	model: SelectionModel,
	current: string | undefined,
): string | undefined {
	if (current !== undefined && model.reasoning.levels.includes(current))
		return current;
	return model.reasoning.default;
}

/** Keeps a custom temperature only while the catalog says it is meaningful. */
export function temperatureForModel(
	model: SelectionModel,
	reasoning: string | undefined,
	current: number | undefined,
) {
	const capability = model.temperature;
	if (!capability) return undefined;
	if (
		capability.reasoning &&
		(reasoning === undefined || !capability.reasoning.includes(reasoning))
	)
		return undefined;
	if (
		current === undefined ||
		!Number.isFinite(current) ||
		current < capability.min ||
		current > capability.max
	)
		return undefined;
	return current;
}

/**
 * Corrects a remembered selection against the catalog: a retired model falls
 * back to the catalog's first entry, a level the model does not accept falls
 * back to its default, unknown tools are dropped. Nothing remembered starts
 * from the catalog's first model with the default tools.
 */
export function restoreSelection(
	catalog: SelectionCatalog,
	remembered: StoredAgentSelection | undefined,
): AgentSelection {
	const model =
		catalog.models.find((entry) => entry.id === remembered?.model) ??
		catalog.models[0];
	const known = new Set(catalog.tools.map((tool) => tool.name));
	const wanted = remembered?.tools ?? DEFAULT_AGENT_TOOLS;
	const reasoning = model
		? reasoningForModel(model, remembered?.reasoning)
		: undefined;
	const temperature = model
		? temperatureForModel(model, reasoning, remembered?.temperature)
		: undefined;
	const maxSteps =
		remembered?.maxSteps !== undefined &&
		Number.isInteger(remembered.maxSteps) &&
		remembered.maxSteps >= 1
			? remembered.maxSteps
			: 5;
	return {
		model: model?.id ?? '',
		...(reasoning === undefined ? {} : { reasoning }),
		tools: wanted.filter((tool) => known.has(tool)),
		maxSteps,
		...(temperature === undefined ? {} : { temperature }),
	};
}

export function draftThreadTitle(text: string) {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.slice(0, THREAD_TITLE_MAX) || 'New chat';
}

export type AgentSource = { title: string; url: string };

/**
 * Tool inputs and outputs cross the wire as untyped JSON, so they are read
 * with guards — never casts — and a malformed shape renders as nothing
 * instead of crashing the transcript.
 */
export function tavilyQuery(input: unknown): string | undefined {
	if (!input || typeof input !== 'object') return undefined;
	const query = (input as Record<string, unknown>).query;
	return typeof query === 'string' && query.length > 0 ? query : undefined;
}

export function tavilySources(output: unknown): AgentSource[] {
	if (!output || typeof output !== 'object') return [];
	const results = (output as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];
	const sources: AgentSource[] = [];
	for (const result of results) {
		if (!result || typeof result !== 'object') continue;
		const { title, url } = result as Record<string, unknown>;
		if (typeof title === 'string' && typeof url === 'string')
			sources.push({ title, url });
	}
	return sources;
}

/**
 * The pure half of the auto-scroll: whether the reader is close enough to the
 * bottom of the document for the stream to keep carrying them along. Someone
 * who scrolled up to reread must never be dragged down by the next token.
 */
export function isPinnedToBottom(
	scrollY: number,
	viewportHeight: number,
	scrollHeight: number,
	threshold = 96,
) {
	return scrollY + viewportHeight >= scrollHeight - threshold;
}

/**
 * Marks the user turns that question-to-question navigation jumps between.
 * The transcript writes it on each of its own rows and the toolbar reads it
 * from the DOM at click time: the positions only matter the instant the
 * button is pressed, so tracking them in state would re-render the list to
 * maintain a list nothing else reads.
 */
export const USER_ANCHOR_ATTR = 'data-user-anchor';

/** The shell's sticky header covers the top of the page. */
export const HEADER_OFFSET = 64;

/**
 * The turn to jump to when walking a long thread by its own questions.
 *
 * Positions are the tops of the user messages, in document order, and
 * `current` is the viewport's reference line. Walking up looks for the last
 * position clearly above it and walking down for the first clearly below, so
 * repeated presses always move: an exact tie would otherwise land on the
 * message already in view and appear stuck.
 */
export function findAdjacentAnchor(
	positions: readonly number[],
	current: number,
	direction: 'previous' | 'next',
	slack = 8,
) {
	if (direction === 'next')
		return positions.find((position) => position > current + slack);
	return [...positions]
		.reverse()
		.find((position) => position < current - slack);
}

/**
 * How long a jump between turns takes. The browser's own `smooth` scales its
 * duration with the distance, so hopping over a long answer crawled; a fixed,
 * short animation reads as a jump that you can still follow.
 */
const SCROLL_ANIMATION_MS = 180;

/** Fast ease-out: most of the distance up front, no lingering tail. */
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export function scrollWindowTo(top: number) {
	const target = Math.max(0, top);
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		window.scrollTo({ top: target, behavior: 'instant' });
		return;
	}

	const from = window.scrollY;
	const distance = target - from;
	if (distance === 0) return;

	const start = performance.now();
	const step = (now: number) => {
		const progress = Math.min(1, (now - start) / SCROLL_ANIMATION_MS);
		window.scrollTo({ top: from + distance * easeOut(progress) });
		if (progress < 1) window.requestAnimationFrame(step);
	};
	window.requestAnimationFrame(step);
}

/** Scrolls to the question before or after the viewport's reference line. */
export function jumpToUserMessage(direction: 'previous' | 'next') {
	const positions = [...document.querySelectorAll(`[${USER_ANCHOR_ATTR}]`)].map(
		(node) =>
			node.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET - 12,
	);
	const target = findAdjacentAnchor(positions, window.scrollY, direction);
	if (target === undefined) return false;
	scrollWindowTo(target);
	return true;
}

/** Throughput of one turn, or nothing when the timings cannot support it. */
export function tokensPerSecond(
	outputTokens: number | undefined,
	durationMs: number | undefined,
) {
	if (!outputTokens || !durationMs || durationMs <= 0) return undefined;
	return (outputTokens * 1000) / durationMs;
}

/** Compact human durations: sub-second in ms, the rest in seconds. */
export function formatDuration(ms: number | undefined) {
	if (ms === undefined || ms < 0) return undefined;
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatTokenCount(tokens: number | undefined) {
	if (tokens === undefined) return undefined;
	return tokens >= 10_000
		? `${(tokens / 1000).toFixed(1)}k tokens`
		: `${tokens} tokens`;
}

/**
 * The one sentence for a thread whose mutation lease a running turn holds.
 *
 * A `409` is the designed answer while that lease is out, never a
 * connectivity problem, and it reaches the reader through two different
 * doors — a store write and a failed turn in the transcript — so the wording
 * lives here rather than once per door.
 */
export const threadBusyFailure = (subject: string) =>
	`${subject} has to wait: this conversation is busy with a running turn.`;

/** Server error bodies the transcript can say in words, keyed by their code. */
const TURN_FAILURES: Record<string, string> = {
	AGENT_THREAD_BUSY: threadBusyFailure('This message'),
};

/**
 * A failed turn, as a person reads it.
 *
 * `useChat` hands the response body through `error.message`, so a refusal the
 * API designed arrives as the literal `{"error":"AGENT_THREAD_BUSY"}`.
 * Anything unrecognized is shown exactly as it came: an unforeseen failure's
 * only description is the one the server sent, and swallowing it leaves the
 * row saying nothing.
 */
export function turnFailureMessage(error?: { message?: string }): string {
	const raw = error?.message?.trim();
	if (!raw) return 'The reply failed.';
	for (const [code, sentence] of Object.entries(TURN_FAILURES))
		if (raw.includes(code)) return sentence;
	return raw;
}

/** The plain text of a message, for the clipboard. */
export function messageText(parts: readonly unknown[]) {
	return parts
		.map((part) => {
			if (!part || typeof part !== 'object') return '';
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === 'text' && typeof candidate.text === 'string'
				? candidate.text
				: '';
		})
		.filter(Boolean)
		.join('\n\n');
}
