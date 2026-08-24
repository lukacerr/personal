// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import {
	AGENT_PREFERENCES_KEY,
	DEFAULT_AGENT_PREFERENCES,
	loadAgentPreferences,
	saveAgentPreferences,
	useAgentPreferences,
} from '@web/lib/agent-preferences';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(initial?: string) {
	let value = initial ?? null;
	return {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
}

describe('Agent preferences', () => {
	it('persists valid per-device choices and falls back safely', () => {
		const storage = memoryStorage();
		saveAgentPreferences(storage, { fontSize: 'large', margins: 'small' });

		expect(loadAgentPreferences(storage)).toEqual({
			fontSize: 'large',
			margins: 'small',
		});
		expect(loadAgentPreferences(memoryStorage('{invalid'))).toEqual(
			DEFAULT_AGENT_PREFERENCES,
		);
		expect(
			loadAgentPreferences(
				memoryStorage(
					JSON.stringify({ version: 1, fontSize: 'huge', margins: 'small' }),
				),
			),
		).toEqual(DEFAULT_AGENT_PREFERENCES);
		expect(
			loadAgentPreferences(
				memoryStorage(
					JSON.stringify({ version: 2, fontSize: 'large', margins: 'small' }),
				),
			),
		).toEqual(DEFAULT_AGENT_PREFERENCES);
	});

	// The key is the whole reason Notes and Agent stay separate modules, so it is
	// asserted as a literal rather than through the exported constant.
	it('reads and writes only its own storage key', () => {
		const written: Record<string, string> = {};
		saveAgentPreferences(
			{
				setItem: (key, value) => {
					written[key] = value;
				},
			},
			{ fontSize: 'small', margins: 'large' },
		);

		expect(Object.keys(written)).toEqual(['personal-agent-view:v1']);
		expect(AGENT_PREFERENCES_KEY).toBe('personal-agent-view:v1');

		const read: string[] = [];
		loadAgentPreferences({
			getItem: (key) => {
				read.push(key);
				return written[key] ?? null;
			},
		});
		expect(read).toEqual(['personal-agent-view:v1']);
	});
});

describe('useAgentPreferences', () => {
	// happy-dom leaves `window.localStorage` undefined here, and the hook reads it
	// directly, so the stub goes where the hook looks for it.
	const store = new Map<string, string>();
	const writes: string[] = [];

	beforeEach(() => {
		store.clear();
		writes.length = 0;
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				writes.push(key);
				store.set(key, value);
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Under StrictMode React double-invokes state updater functions, so a single
	// write per change is what proves persisting stayed outside the updater.
	it('persists one write per change, under its own key', () => {
		const { result } = renderHook(() => useAgentPreferences(), {
			wrapper: StrictMode,
		});
		expect(result.current.preferences).toEqual(DEFAULT_AGENT_PREFERENCES);

		act(() => {
			result.current.setPreference('margins', 'small');
		});

		expect(result.current.preferences).toEqual({
			fontSize: 'medium',
			margins: 'small',
		});
		expect(writes).toEqual(['personal-agent-view:v1']);
		expect(store.get('personal-agent-view:v1')).toBe(
			JSON.stringify({ version: 1, fontSize: 'medium', margins: 'small' }),
		);
		expect(store.has('personal-notes-view:v1')).toBe(false);
	});
});
