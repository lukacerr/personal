import { getSafeReturnTo } from '@web/lib/session';
import { useEffect, useRef, useState } from 'react';

const APP_LOCATION_KEY = 'personal-app-location:v1';

type LocationStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function rememberAppLocation(storage: LocationStorage, href: string) {
	try {
		const location = new URL(href, 'https://personal.local');
		storage.setItem(APP_LOCATION_KEY, `${location.pathname}${location.search}`);
	} catch {
		// Location persistence is best-effort when browser storage is unavailable.
	}
}

export function getStartupRedirect(
	currentHref: string,
	storage: LocationStorage,
) {
	if (currentHref !== '/') return null;
	try {
		const remembered = getSafeReturnTo(storage.getItem(APP_LOCATION_KEY));
		return remembered === '/' ? null : remembered;
	} catch {
		return null;
	}
}

/**
 * Restoring the last location is a startup decision, not a route guard, and the
 * layout that renders the redirect stays mounted across it. Holding the target
 * forever would keep replacing the app shell with a redirect, and re-reading it
 * on every render would bounce the user off the root for the rest of the
 * session. It is consumed the moment the app leaves the location it started at,
 * which also survives the renders spent waiting for the session to boot.
 */
export function useStartupRedirect(
	currentHref: string,
	storage: LocationStorage,
) {
	const startHref = useRef(currentHref).current;
	const [target, setTarget] = useState(() =>
		getStartupRedirect(currentHref, storage),
	);

	useEffect(() => {
		if (target && currentHref !== startHref) setTarget(null);
	}, [currentHref, startHref, target]);

	return currentHref === startHref ? target : null;
}
