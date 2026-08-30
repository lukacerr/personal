import {
	AGENT_UPLOAD_FOLDER,
	appendFileMentions,
	completeFileMention,
	FILE_MENTION_PATTERN,
	mentionStateAt,
	mentionTriggerAt,
	splitFileMentions,
	toolsForTurn,
} from '@web/lib/agent-mentions';
import { describe, expect, test } from 'vitest';

const FILE_ID = '0198c9a2-1111-7000-8000-abcdefabcdef';

describe('mentionTriggerAt', () => {
	test('fires on @ at the start and after whitespace', () => {
		expect(mentionTriggerAt('@', 1)).toBe(0);
		expect(mentionTriggerAt('look at @', 9)).toBe(8);
		expect(mentionTriggerAt('line\n@', 6)).toBe(5);
	});

	test('does not fire mid-word or away from the caret', () => {
		expect(mentionTriggerAt('mail@', 5)).toBeUndefined();
		expect(mentionTriggerAt('@ later', 7)).toBeUndefined();
		expect(mentionTriggerAt('', 0)).toBeUndefined();
	});
});

describe('mentionStateAt', () => {
	test('@ and @f open the namespace stage', () => {
		expect(mentionStateAt('@', 1)).toEqual({ at: 0, stage: 'namespace' });
		expect(mentionStateAt('see @f', 6)).toEqual({ at: 4, stage: 'namespace' });
	});

	test('@f: opens the file search with the typed query', () => {
		expect(mentionStateAt('see @f:', 7)).toEqual({
			at: 4,
			stage: 'files',
			query: '',
		});
		expect(mentionStateAt('see @f:repo', 11)).toEqual({
			at: 4,
			stage: 'files',
			query: 'repo',
		});
	});

	test('closes on whitespace, mid-word @ and other namespaces', () => {
		expect(mentionStateAt('see @f: done', 12)).toBeUndefined();
		expect(mentionStateAt('mail@f:', 7)).toBeUndefined();
		expect(mentionStateAt('@x:', 3)).toBeUndefined();
		expect(mentionStateAt('plain text', 5)).toBeUndefined();
	});
});

describe('completeFileMention', () => {
	test('replaces the whole active token with the mention', () => {
		const result = completeFileMention('see @f:rep now', 4, 10, FILE_ID);
		expect(result.text).toBe(`see @f:${FILE_ID}  now`);
		expect(result.caret).toBe(`see @f:${FILE_ID} `.length);
	});
});

describe('appendFileMentions', () => {
	test('appends one token per file with separating space', () => {
		expect(appendFileMentions('look', [FILE_ID])).toBe(`look @f:${FILE_ID} `);
		expect(appendFileMentions('', [FILE_ID])).toBe(`@f:${FILE_ID} `);
	});
});

describe('splitFileMentions', () => {
	test('plain text is one segment', () => {
		expect(splitFileMentions('hello')).toEqual([
			{ kind: 'text', text: 'hello' },
		]);
	});

	test('mentions become their own segments', () => {
		expect(splitFileMentions(`see @f:${FILE_ID} please`)).toEqual([
			{ kind: 'text', text: 'see ' },
			{ kind: 'mention', fileId: FILE_ID, token: `@f:${FILE_ID}` },
			{ kind: 'text', text: ' please' },
		]);
	});

	test('malformed tokens stay text', () => {
		expect(splitFileMentions('@f:not-a-uuid')).toEqual([
			{ kind: 'text', text: '@f:not-a-uuid' },
		]);
	});
});

describe('toolsForTurn', () => {
	test('grants only the read tool when the draft mentions a file', () => {
		// Searching storage stays an intentional grant; a mention only proves
		// the turn needs to read that one file.
		expect(toolsForTurn([], `read @f:${FILE_ID}`)).toEqual(['storageRead']);
	});

	test('never duplicates an already granted tool', () => {
		expect(toolsForTurn(['storageRead', 'tavily'], `@f:${FILE_ID}`)).toEqual([
			'storageRead',
			'tavily',
		]);
	});

	test('leaves the selection alone without mentions', () => {
		expect(toolsForTurn(['tavily'], 'no files here')).toEqual(['tavily']);
	});
});

describe('constants', () => {
	test('the pattern is global and reusable across calls', () => {
		const text = `@f:${FILE_ID} and @f:${FILE_ID}`;
		expect(text.match(FILE_MENTION_PATTERN)).toHaveLength(2);
		// A stateful regex would miss matches on the next call.
		expect(text.match(FILE_MENTION_PATTERN)).toHaveLength(2);
	});

	test('agent uploads land in their own folder', () => {
		expect(AGENT_UPLOAD_FOLDER).toBe('Agent');
	});
});
