import {
	AGENT_MAX_STEPS,
	AGENT_SETTINGS_KEY,
	DEFAULT_AGENT_SETTINGS,
	loadAgentSettings,
	reconcileAgentSettings,
	saveAgentSettings,
} from '@web/lib/agent-settings';
import { describe, expect, it } from 'vitest';

function fakeStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		read: (key: string) => values.get(key),
	};
}

const selection = {
	model: 'model-a',
	reasoning: 'high',
	tools: ['tavily'],
	maxSteps: 12,
	temperature: 0.7,
};

describe('agent settings local mirror', () => {
	it('round-trips every shared Agent choice under a versioned key', () => {
		const storage = fakeStorage();
		const settings = {
			selection,
			titleModel: 'title-a',
			compactionModel: 'compact-a',
		};

		saveAgentSettings(storage, settings);

		expect(AGENT_SETTINGS_KEY).toBe('personal-agent-settings:v1');
		expect(loadAgentSettings(storage)).toEqual(settings);
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
		'ignores a non-positive-integer maxSteps value of %s',
		(maxSteps) => {
			const storage = fakeStorage({
				[AGENT_SETTINGS_KEY]: JSON.stringify({
					version: 1,
					selection: { ...selection, maxSteps },
				}),
			});
			expect(loadAgentSettings(storage)).toEqual(DEFAULT_AGENT_SETTINGS);
		},
	);

	/**
	 * A value written before the ceiling existed is a remembered choice, not a
	 * live request: pinning it keeps the model and tools it was stored with,
	 * where rejecting the object would drop choices the user can still use.
	 */
	it('pins a remembered maxSteps above the ceiling instead of dropping it', () => {
		const stored = { ...selection, maxSteps: AGENT_MAX_STEPS + 750 };
		const storage = fakeStorage({
			[AGENT_SETTINGS_KEY]: JSON.stringify({ version: 1, selection: stored }),
		});

		expect(loadAgentSettings(storage)).toEqual({
			selection: { ...selection, maxSteps: AGENT_MAX_STEPS },
		});
		expect(loadAgentSettings(fakeStorage(), stored)).toEqual({
			selection: { ...selection, maxSteps: AGENT_MAX_STEPS },
		});
	});

	it('migrates the legacy selection only when the new mirror has no copy', () => {
		const empty = fakeStorage();
		expect(loadAgentSettings(empty, selection)).toEqual({ selection });

		const current = fakeStorage({
			[AGENT_SETTINGS_KEY]: JSON.stringify({
				version: 1,
				titleModel: 'title-a',
			}),
		});
		expect(loadAgentSettings(current, selection)).toEqual({
			titleModel: 'title-a',
		});
	});

	it('defaults maxSteps while migrating a legacy selection that predates it', () => {
		const legacy = {
			model: 'model-a',
			reasoning: 'high',
			tools: ['tavily'],
			temperature: 0.7,
		};

		expect(loadAgentSettings(fakeStorage(), legacy)).toEqual({
			selection: { ...legacy, maxSteps: 5 },
		});
	});

	it('survives blocked storage', () => {
		const blocked = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
		};
		expect(loadAgentSettings(blocked, selection)).toEqual({ selection });
		expect(() => saveAgentSettings(blocked, { selection })).not.toThrow();
	});
});

describe('agent settings reconciliation', () => {
	const local = { selection };

	it('adopts and mirrors any shared copy, including an empty object', () => {
		expect(
			reconcileAgentSettings({ titleModel: 'shared-title' }, local),
		).toEqual({
			settings: { titleModel: 'shared-title' },
			push: false,
		});
		expect(reconcileAgentSettings({}, local)).toEqual({
			settings: {},
			push: false,
		});
	});

	it('seeds a missing shared copy from remembered local settings', () => {
		expect(reconcileAgentSettings(null, local)).toEqual({
			settings: local,
			push: true,
		});
	});

	it('uses empty defaults when neither copy exists', () => {
		expect(reconcileAgentSettings(null, DEFAULT_AGENT_SETTINGS)).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			push: false,
		});
	});
});
