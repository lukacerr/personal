/**
 * The file-mention grammar of the composer: `@f:<fileId>` inside plain text.
 * The token is what actually travels — the server's system prompt teaches the
 * model to read it and pass the id to the `storageRead` tool — so everything
 * here is pure string work, shared by the composer (insertion), the
 * transcript (rendering mentions as chips) and the submit path (granting the
 * storage tools for a turn that mentions files).
 *
 * The namespace prefix is deliberate: `@f:` is Files today, `@n:` is reserved
 * for Notes when that system joins the picker.
 */

/** Where composer uploads (drop, paste, attach) land in Storage. */
export const AGENT_UPLOAD_FOLDER = 'Agent';

const UUID_SOURCE = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

/**
 * Built fresh on every access: a shared `g` regex keeps `lastIndex` between
 * calls and silently skips matches.
 */
export const FILE_MENTION_PATTERN = new RegExp(`@f:${UUID_SOURCE}`, 'gi');

/** Stateless variant for yes/no checks: `.test` on a `g` regex keeps state. */
const FILE_MENTION_TEST = new RegExp(`@f:${UUID_SOURCE}`, 'i');

/** Whether the draft names at least one stored file. */
export function draftMentionsFiles(text: string) {
	return FILE_MENTION_TEST.test(text);
}

export type MentionSegment =
	| { kind: 'text'; text: string }
	| { kind: 'mention'; fileId: string; token: string };

/**
 * Where the `@` that should open the picker sits, if the caret is right after
 * one that starts a word. Mid-word `@`s (emails) and `@`s the caret moved away
 * from never trigger.
 */
export function mentionTriggerAt(
	text: string,
	caret: number,
): number | undefined {
	if (caret < 1 || text[caret - 1] !== '@') return undefined;
	const before = text[caret - 2];
	return before === undefined || /\s/.test(before) ? caret - 1 : undefined;
}

export type MentionState =
	/** `@` or `@f` typed: the namespace list. */
	| { at: number; stage: 'namespace' }
	/** `@f:` plus whatever query follows, up to the caret. */
	| { at: number; stage: 'files'; query: string };

/**
 * The picker's state as a pure function of the draft and the caret. The query
 * is typed into the textarea itself — the picker never steals focus — so this
 * is what each keystroke re-derives: `@` at a word start opens the namespace
 * list, `@f:` switches to the file search, anything else closes it.
 */
export function mentionStateAt(
	text: string,
	caret: number,
): MentionState | undefined {
	const at = text.lastIndexOf('@', caret - 1);
	if (at === -1) return undefined;
	const before = text[at - 1];
	if (before !== undefined && !/\s/.test(before)) return undefined;
	const token = text.slice(at, caret);
	if (token === '@' || token.toLowerCase() === '@f')
		return { at, stage: 'namespace' };
	const files = /^@f:(\S*)$/i.exec(token);
	if (files) return { at, stage: 'files', query: files[1] ?? '' };
	return undefined;
}

/** Replaces the active mention token (`at`..caret) with the file's token. */
export function completeFileMention(
	text: string,
	at: number,
	caret: number,
	fileId: string,
) {
	const token = `@f:${fileId} `;
	const nextText = `${text.slice(0, at)}${token}${text.slice(caret)}`;
	return { text: nextText, caret: at + token.length };
}

/** Appends one token per uploaded file, space-separated. */
export function appendFileMentions(text: string, fileIds: readonly string[]) {
	const tokens = fileIds.map((id) => `@f:${id} `).join('');
	if (text.length === 0 || /\s$/.test(text)) return `${text}${tokens}`;
	return `${text} ${tokens}`;
}

/** The text split into plain runs and mention tokens, for chip rendering. */
export function splitFileMentions(text: string): MentionSegment[] {
	const segments: MentionSegment[] = [];
	const pattern = new RegExp(`@f:(${UUID_SOURCE})`, 'gi');
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last)
			segments.push({ kind: 'text', text: text.slice(last, match.index) });
		segments.push({
			kind: 'mention',
			fileId: (match[1] ?? '').toLowerCase(),
			token: match[0],
		});
		last = match.index + match[0].length;
	}
	if (last < text.length || segments.length === 0)
		segments.push({ kind: 'text', text: text.slice(last) });
	return segments;
}

/**
 * The tools a turn needs on top of what the user selected: a message that
 * mentions files must be able to read them, whatever the saved selection
 * says. Only `storageRead` — searching storage stays an intentional grant —
 * and never touches stored settings: this is per-send only. The composer
 * mirrors the same rule in the tool picker so the widening is visible.
 */
export function toolsForTurn(tools: readonly string[], draft: string) {
	if (!draftMentionsFiles(draft) || tools.includes('storageRead'))
		return [...tools];
	return [...tools, 'storageRead'];
}
