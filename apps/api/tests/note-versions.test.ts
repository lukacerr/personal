import { describe, expect, it } from 'bun:test';
import {
	isKeyframe,
	KEYFRAME_INTERVAL,
	type NoteHead,
	reconstructVersion,
	reverseDelta,
	type VersionRow,
} from '@api/note-versions';
import type { Block } from '@blocknote/core';
import { randomUUIDv7 } from 'bun';

function paragraph(id: string, text: string) {
	return {
		id,
		type: 'paragraph',
		props: {
			backgroundColor: 'default',
			textAlignment: 'left',
			textColor: 'default',
		},
		content: [{ type: 'text', text, styles: {} }],
		children: [],
	} as unknown as Block;
}

function at(index: number) {
	return new Date(2_000_000 - index * 1_000);
}

/**
 * Builds a note the way it is actually stored: the current document on the
 * note, and every older version as a reverse delta pointing at its successor.
 */
function storedNote(documents: Block[][]) {
	const [current, ...past] = documents;
	if (!current) throw new Error('A note needs at least one version');

	const head: NoteHead = { updatedAt: at(0), content: current };
	const rows: VersionRow[] = past.map((document, index) => {
		const newer = documents[index];
		if (!newer) throw new Error('missing newer document');
		return {
			createdAt: at(index + 1),
			content: null,
			delta: reverseDelta(newer, document),
			baseCreatedAt: at(index),
		};
	});
	return { head, rows };
}

describe('Note versions', () => {
	it('reserves a keyframe once per interval', () => {
		expect(isKeyframe(KEYFRAME_INTERVAL)).toBe(true);
		expect(isKeyframe(KEYFRAME_INTERVAL * 3)).toBe(true);
		expect(isKeyframe(1)).toBe(false);
		expect(isKeyframe(KEYFRAME_INTERVAL - 1)).toBe(false);
	});

	it('serves the current version straight from the note', () => {
		const documents = [[paragraph('a', 'Now')], [paragraph('a', 'Before')]];
		const { head, rows } = storedNote(documents);

		expect(reconstructVersion(head, rows, head.updatedAt)).toBe(head.content);
	});

	it('rebuilds every past version by walking its chain to the anchor', () => {
		const documents = [
			[paragraph('a', 'One edited'), paragraph('c', 'Three')],
			[paragraph('a', 'One edited'), paragraph('b', 'Two')],
			[paragraph('a', 'One'), paragraph('b', 'Two')],
		];
		const { head, rows } = storedNote(documents);

		for (const [index, document] of documents.entries())
			expect(reconstructVersion(head, rows, at(index))).toEqual(document);
	});

	it('survives a chain as long as a full keyframe interval', () => {
		const documents = Array.from({ length: KEYFRAME_INTERVAL }, (_, index) => [
			paragraph('a', `Revision ${KEYFRAME_INTERVAL - index}`),
		]);
		const { head, rows } = storedNote(documents);

		expect(reconstructVersion(head, rows, at(documents.length - 1))).toEqual(
			documents.at(-1),
		);
	});

	it('rebuilds from a stored snapshot without reaching the current document', () => {
		const keyframe = [paragraph('a', 'Keyframe')];
		const head: NoteHead = {
			updatedAt: at(0),
			content: [paragraph('a', 'Now')],
		};
		const rows: VersionRow[] = [
			{ createdAt: at(1), content: keyframe, delta: null, baseCreatedAt: null },
			{
				createdAt: at(2),
				content: null,
				delta: reverseDelta(keyframe, [paragraph('a', 'Older')]),
				baseCreatedAt: at(1),
			},
		];

		expect(reconstructVersion(head, rows, at(2))).toEqual([
			paragraph('a', 'Older'),
		]);
	});

	it('reports a broken chain instead of returning a wrong document', () => {
		const head: NoteHead = {
			updatedAt: at(0),
			content: [paragraph('a', 'Now')],
		};
		const orphan: VersionRow = {
			createdAt: at(5),
			content: null,
			delta: reverseDelta([paragraph('a', 'Gone')], [paragraph('a', 'Older')]),
			// Points at a version that is not among the rows and is not the head.
			baseCreatedAt: at(4),
		};

		expect(reconstructVersion(head, [orphan], at(5))).toBeUndefined();
	});

	it('keeps a delta far smaller than the snapshot it replaces', () => {
		const big = Array.from({ length: 200 }, (_, index) =>
			paragraph(
				randomUUIDv7(),
				`Paragraph number ${index} with some prose in it`,
			),
		);
		const edited = big.map((block, index) =>
			index === 7 ? paragraph(block.id, 'Only this paragraph changed') : block,
		);

		const delta = JSON.stringify(reverseDelta(edited, big)).length;
		const snapshot = JSON.stringify(big).length;

		expect(delta).toBeLessThan(snapshot / 10);
	});
});
