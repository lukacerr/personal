import {
	groupCounts,
	matchesEntity,
	type PickerEntity,
	resolveGroup,
	visibleEntities,
} from '@web/components/agent/agent-entity-picker';
import { describe, expect, it } from 'vitest';

const entities: PickerEntity[] = [
	{ id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Anthropic' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', group: 'Anthropic' },
	{
		id: 'qwen/qwen3.8-max',
		label: 'Qwen3.8 Max',
		group: 'Novita',
		hint: 'Open weights',
	},
];

describe('picker matching', () => {
	/**
	 * The identifier is what a provider's docs call the model and the group is
	 * what the rail calls it, so both have to answer the search: typing
	 * "anthropic" or "haiku-4-5" has to find the same row the eye would.
	 */
	it('searches every field a row shows or is keyed by', () => {
		const [opus, , qwen] = entities as [PickerEntity, unknown, PickerEntity];
		expect(matchesEntity(opus, '')).toBe(true);
		expect(matchesEntity(opus, 'OPUS')).toBe(true);
		expect(matchesEntity(opus, 'anthropic')).toBe(true);
		expect(matchesEntity(qwen, 'open weights')).toBe(true);
		expect(matchesEntity(qwen, 'anthropic')).toBe(false);
	});

	it('counts matches per group in catalogue order', () => {
		expect(groupCounts(entities, '')).toEqual([
			{ group: 'Anthropic', count: 2 },
			{ group: 'Novita', count: 1 },
		]);
		expect(groupCounts(entities, 'qwen')).toEqual([
			{ group: 'Anthropic', count: 0 },
			{ group: 'Novita', count: 1 },
		]);
	});
});

/**
 * A rail filter is a convenience, not a commitment: leaving it on while the
 * query matches nothing inside it would answer "nothing matches" with the row
 * one click away. Falling back to all groups is the answer that shows it.
 */
describe('group filter', () => {
	it('yields to a query no row of the active group matches', () => {
		const counts = groupCounts(entities, 'qwen');
		expect(resolveGroup('Anthropic', counts)).toBeUndefined();
		expect(resolveGroup('Novita', counts)).toBe('Novita');
		expect(resolveGroup(undefined, counts)).toBeUndefined();
	});

	it('narrows to the group and the query together', () => {
		expect(
			visibleEntities(entities, 'Anthropic', 'claude').map(
				(entity) => entity.id,
			),
		).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
		expect(
			visibleEntities(entities, 'Anthropic', 'opus').map((entity) => entity.id),
		).toEqual(['claude-opus-5']);
	});
});
