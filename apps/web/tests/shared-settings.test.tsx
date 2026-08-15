// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import {
	type SharedSettingsAdapter,
	useSharedSettings,
} from '@web/lib/shared-settings';
import { describe, expect, it, vi } from 'vitest';

type Settings = { budget?: number };

function adapterOf(overrides: Partial<SharedSettingsAdapter<Settings>> = {}) {
	const adapter: SharedSettingsAdapter<Settings> = {
		defaults: {},
		loadLocal: vi.fn(() => ({})),
		saveLocal: vi.fn(),
		readShared: vi.fn(async () => null),
		writeShared: vi.fn(async () => true),
		// The shared copy decides when it exists — even empty; otherwise a
		// remembered local seeds it. Each system's real precedence lives in its
		// own reconcile function; this stand-in mirrors the shape they share.
		reconcile: (shared, local) =>
			shared !== null
				? { settings: shared, push: false }
				: { settings: local, push: Object.keys(local).length > 0 },
		...overrides,
	};
	return adapter;
}

describe('useSharedSettings', () => {
	it('adopts the shared copy and mirrors it locally', async () => {
		const adapter = adapterOf({
			readShared: vi.fn(async () => ({ budget: 7 })),
		});
		const { result } = renderHook(() => useSharedSettings(adapter));

		await waitFor(() => expect(result.current.settings).toEqual({ budget: 7 }));
		expect(adapter.saveLocal).toHaveBeenCalledWith({ budget: 7 });
		// Adopting is not seeding: nothing goes back up.
		expect(adapter.writeShared).not.toHaveBeenCalled();
	});

	it('seeds the shared copy from this device when the cache has none', async () => {
		const adapter = adapterOf({ loadLocal: vi.fn(() => ({ budget: 3 })) });
		const { result } = renderHook(() => useSharedSettings(adapter));

		await waitFor(() => expect(result.current.settings).toEqual({ budget: 3 }));
		expect(adapter.writeShared).toHaveBeenCalledWith({ budget: 3 });
	});

	/** The screen has to reflect a change whether or not the cache is reachable. */
	it('writes the mirror first and synchronously on a patch', async () => {
		const adapter = adapterOf();
		const { result } = renderHook(() => useSharedSettings(adapter));
		await waitFor(() => expect(adapter.readShared).toHaveBeenCalled());

		act(() => result.current.patchSettings({ budget: 9 }));

		expect(result.current.settings).toEqual({ budget: 9 });
		expect(adapter.saveLocal).toHaveBeenCalledWith({ budget: 9 });
		expect(adapter.writeShared).toHaveBeenCalledWith({ budget: 9 });
	});
});
