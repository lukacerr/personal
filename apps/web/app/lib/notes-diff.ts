import type { NoteBlock } from '@web/lib/notes-schema';
import { create } from 'jsondiffpatch';

/**
 * Blocks carry a stable `id`, so arrays are matched by identity instead of by
 * position. Without this a single inserted paragraph would diff as "every block
 * after it changed" rather than as one insertion.
 */
const differ = create({
	objectHash: (value: unknown, index?: number) =>
		typeof value === 'object' && value !== null && 'id' in value
			? String((value as { id: unknown }).id)
			: // Inline content has no id. Returning undefined would make jsondiffpatch
				// fail to match those items and report every one as removed and re-added,
				// so they fall back to positional matching.
				`$$index:${index}`,
	arrays: { detectMove: true, includeValueOnMove: false },
});

export type NoteBlockStatus = 'restored' | 'changed' | 'moved';

export type NoteVersionDiff = {
	identical: boolean;
	/** Present only in the snapshot: restoring brings these back. */
	restored: string[];
	/** Present in both, with different content. */
	changed: string[];
	/** Same content, different position. */
	moved: string[];
	/** Present only in the current version: restoring drops them. */
	removedCount: number;
	/** Block id to status, for highlighting the rendered snapshot. */
	status: Record<string, NoteBlockStatus>;
};

type FlatBlock = { block: NoteBlock; parentId: string | null; index: number };

function flatten(
	blocks: NoteBlock[],
	parentId: string | null = null,
	into: FlatBlock[] = [],
) {
	blocks.forEach((block, index) => {
		into.push({ block, parentId, index });
		flatten(block.children ?? [], block.id, into);
	});
	return into;
}

/** Compares a block on its own, so a changed child does not mark its parent. */
function withoutChildren(block: NoteBlock) {
	const { children: _children, ...rest } = block;
	return rest;
}

/**
 * Describes what restoring `snapshot` would do to `current`.
 *
 * The comparison is deliberately per block rather than a whole-document delta:
 * the history view highlights individual blocks, and a document-level delta
 * cannot be mapped back onto the blocks BlockNote renders.
 */
export function diffNoteVersions(
	snapshot: NoteBlock[],
	current: NoteBlock[],
): NoteVersionDiff {
	const snapshotBlocks = flatten(snapshot);
	const currentBlocks = flatten(current);
	const currentById = new Map(
		currentBlocks.map((entry) => [entry.block.id, entry]),
	);
	const snapshotIds = new Set(snapshotBlocks.map((entry) => entry.block.id));

	const restored: string[] = [];
	const changed: string[] = [];
	const moved: string[] = [];
	const status: Record<string, NoteBlockStatus> = {};

	for (const entry of snapshotBlocks) {
		const id = entry.block.id;
		const currentEntry = currentById.get(id);
		if (!currentEntry) {
			restored.push(id);
			status[id] = 'restored';
			continue;
		}
		if (
			differ.diff(
				withoutChildren(currentEntry.block),
				withoutChildren(entry.block),
			)
		) {
			changed.push(id);
			status[id] = 'changed';
			continue;
		}
		if (
			currentEntry.parentId !== entry.parentId ||
			currentEntry.index !== entry.index
		) {
			moved.push(id);
			status[id] = 'moved';
		}
	}

	const removedCount = currentBlocks.filter(
		(entry) => !snapshotIds.has(entry.block.id),
	).length;

	return {
		identical:
			restored.length === 0 &&
			changed.length === 0 &&
			moved.length === 0 &&
			removedCount === 0,
		restored,
		changed,
		moved,
		removedCount,
		status,
	};
}
