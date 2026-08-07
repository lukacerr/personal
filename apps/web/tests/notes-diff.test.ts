import type { Block } from '@blocknote/core';
import { diffNoteVersions } from '@web/lib/notes-diff';
import { describe, expect, it } from 'vitest';

function block(id: string, text: string, children: Block[] = []): Block {
	return {
		id,
		type: 'paragraph',
		props: {
			backgroundColor: 'default',
			textAlignment: 'left',
			textColor: 'default',
		},
		content: [{ type: 'text', text, styles: {} }],
		children,
	} as Block;
}

describe('Note version diff', () => {
	it('reports an identical snapshot as having nothing to restore', () => {
		const document = [block('a', 'One'), block('b', 'Two')];

		const diff = diffNoteVersions(document, document);

		expect(diff).toMatchObject({
			identical: true,
			restored: [],
			changed: [],
			removedCount: 0,
		});
	});

	it('classifies blocks by what restoring the snapshot would do', () => {
		const current = [block('a', 'One'), block('b', 'Two'), block('c', 'Three')];
		const snapshot = [
			block('a', 'One'),
			block('b', 'Two edited'),
			block('d', 'Four'),
		];

		const diff = diffNoteVersions(snapshot, current);

		expect(diff.identical).toBe(false);
		// `d` only exists in the snapshot, so restoring brings it back.
		expect(diff.restored).toEqual(['d']);
		// `b` exists in both with different content.
		expect(diff.changed).toEqual(['b']);
		// `c` only exists in the current version, so restoring drops it.
		expect(diff.removedCount).toBe(1);
		expect(diff.status.a).toBeUndefined();
	});

	it('detects a block that only moved as unchanged content', () => {
		const current = [block('a', 'One'), block('b', 'Two')];
		const snapshot = [block('b', 'Two'), block('a', 'One')];

		const diff = diffNoteVersions(snapshot, current);

		expect(diff.restored).toEqual([]);
		expect(diff.changed).toEqual([]);
		expect(diff.removedCount).toBe(0);
		expect(diff.moved).toEqual(expect.arrayContaining(['a', 'b']));
		expect(diff.identical).toBe(false);
	});

	it('marks only the edited child, never the parent that contains it', () => {
		const current = [block('a', 'Parent', [block('a1', 'Child')])];
		const snapshot = [block('a', 'Parent', [block('a1', 'Child edited')])];

		const diff = diffNoteVersions(snapshot, current);

		expect(diff.changed).toEqual(['a1']);
		expect(diff.status.a1).toBe('changed');
	});
});
