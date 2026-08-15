import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * The one-shot reconciliation every screen with shared settings runs — the
 * same shape in Calendar and Finance. The shared copy decides whenever there
 * is one, the local mirror seeds it the first time, and every later change
 * writes the mirror first so the screen keeps working with no network. The
 * per-system precedence itself stays in each system's own `reconcile*`
 * function; this hook only does the I/O around it.
 */
export type SharedSettingsAdapter<S> = {
	defaults: S;
	/** The local mirror that keeps the screen alive with no network. */
	loadLocal: () => S;
	saveLocal: (settings: S) => void;
	/** `null` means the cache has nothing; an empty object is still a value. */
	readShared: () => Promise<S | null>;
	/** Resolves `false` when the shared copy could not be written. */
	writeShared: (settings: S) => Promise<boolean>;
	reconcile: (shared: S | null, local: S) => { settings: S; push: boolean };
};

/**
 * Pass a module-level adapter: the reconciliation is keyed on its identity,
 * and an adapter rebuilt per render would rerun it on every render.
 */
export function useSharedSettings<S extends object>(
	adapter: SharedSettingsAdapter<S>,
) {
	const [settings, setSettings] = useState<S>(() =>
		typeof window === 'undefined' ? adapter.defaults : adapter.loadLocal(),
	);

	/**
	 * Adopt the shared copy, or seed it from this device.
	 *
	 * Runs once per visit and never fights the user: a change made while it is
	 * in flight wins, because `settled` stops the answer from landing on top of
	 * it. Failing to reach the cache is silent here — the mirror already has an
	 * answer and there is nothing the user could do about it — but failing to
	 * *save* is not, which is why only `patchSettings` reports.
	 */
	useEffect(() => {
		let settled = false;

		void adapter.readShared().then((shared) => {
			if (settled) return;
			const { settings: next, push } = adapter.reconcile(
				shared,
				adapter.loadLocal(),
			);

			setSettings(next);
			adapter.saveLocal(next);
			if (push) void adapter.writeShared(next);
		});

		return () => {
			settled = true;
		};
	}, [adapter]);

	/**
	 * The mirror is written first and synchronously: the screen has to reflect
	 * the change whether or not the cache is reachable. The shared copy is
	 * reported on, because settings that silently stayed on one device are
	 * exactly the problem sharing them was meant to solve.
	 */
	function patchSettings(changes: Partial<S>) {
		const next = { ...settings, ...changes };
		setSettings(next);
		adapter.saveLocal(next);

		void adapter.writeShared(next).then(
			(stored) => {
				if (!stored)
					toast.error('Saved on this device only — the shared copy is down.');
			},
			() => toast.error('Saved on this device only — no connection.'),
		);
	}

	return { settings, patchSettings };
}
