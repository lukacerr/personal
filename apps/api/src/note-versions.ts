import type { Block } from '@blocknote/core';
import { create, type Delta } from 'jsondiffpatch';

/**
 * One full snapshot is kept every `KEYFRAME_INTERVAL` versions so rebuilding an
 * old version never walks an unbounded chain of patches. Without it, reading the
 * first version of a note edited for years would apply every patch ever made.
 *
 * The interval is applied to the number of versions a note already has. An
 * out-of-order save shifts that count, which only moves where keyframes land;
 * rebuilding follows the stored chain and never this rule.
 */
export const KEYFRAME_INTERVAL = 25;

/**
 * Blocks carry a stable `id`, so arrays are matched by identity rather than by
 * position. `objectHash` must always return a string: returning `undefined`
 * makes jsondiffpatch treat every unmatched item as removed and re-added
 * instead of comparing it.
 */
const differ = create({
	objectHash: (value: unknown, index?: number) =>
		typeof value === 'object' && value !== null && 'id' in value
			? String((value as { id: unknown }).id)
			: `$$index:${index}`,
	arrays: { detectMove: true, includeValueOnMove: false },
});

export function isKeyframe(versionCount: number) {
	return versionCount % KEYFRAME_INTERVAL === 0;
}

/** The patch that turns `newer` back into `older`. */
export function reverseDelta(newer: Block[], older: Block[]): Delta {
	return differ.diff(newer, older);
}

export type VersionRow = {
	createdAt: Date;
	content: Block[] | null;
	delta: Delta | null;
	baseCreatedAt: Date | null;
};

export type NoteHead = { updatedAt: Date; content: Block[] };

/**
 * Rebuilds a past version by walking its chain of reverse deltas up to the
 * nearest anchor and applying them back down. The anchor is either a stored
 * snapshot or the note's current document.
 *
 * `rows` must contain every version the chain passes through; the caller loads
 * them in one query rather than round-tripping per hop.
 */
export function reconstructVersion(
	head: NoteHead,
	rows: VersionRow[],
	createdAt: Date,
): Block[] | undefined {
	if (createdAt.getTime() === head.updatedAt.getTime()) return head.content;

	const byTime = new Map(rows.map((row) => [row.createdAt.getTime(), row]));
	const chain: VersionRow[] = [];

	let anchor: Block[] | undefined;
	let current = byTime.get(createdAt.getTime());
	while (current) {
		if (current.content) {
			anchor = current.content;
			break;
		}
		if (!current.delta || !current.baseCreatedAt) return undefined;
		chain.push(current);
		if (current.baseCreatedAt.getTime() === head.updatedAt.getTime()) {
			anchor = head.content;
			break;
		}
		// A chain longer than the rows it can visit means it loops or points at a
		// version that is gone; reporting nothing beats serving a wrong document.
		if (chain.length > rows.length) return undefined;
		current = byTime.get(current.baseCreatedAt.getTime());
	}

	if (!anchor) return undefined;

	let document = anchor;
	for (const link of chain.reverse()) {
		if (!link.delta) return undefined;
		const patched = differ.patch(structuredClone(document), link.delta);
		if (!Array.isArray(patched)) return undefined;
		document = patched as Block[];
	}
	return document;
}
