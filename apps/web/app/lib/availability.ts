import { api } from '@web/lib/api';
import { useCallback, useEffect, useRef, useState } from 'react';

export type PwaAvailability = 'online' | 'offline';
export type ApiHealthStatus = 'loading' | 'healthy' | 'partial' | 'down';

type HealthResponse = Extract<
	Awaited<ReturnType<typeof api.health.get>>['data'],
	{ checkedAt: string; services: Record<string, boolean> }
>;

export type ApiHealth = {
	status: ApiHealthStatus;
	checkedAt?: string;
	services?: HealthResponse['services'];
};

export function getPwaAvailability(isOnline: boolean): PwaAvailability {
	return isOnline ? 'online' : 'offline';
}

export function classifyApiHealth(
	health: HealthResponse | undefined,
): ApiHealthStatus {
	if (!health) return 'down';
	return health.status === 'operational' ? 'healthy' : 'partial';
}

function isHealthResponse(value: unknown): value is HealthResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		'checkedAt' in value &&
		'services' in value
	);
}

export function getApiHealth(
	result: Awaited<ReturnType<typeof api.health.get>>,
): ApiHealth {
	if (isHealthResponse(result.data)) {
		return {
			status: classifyApiHealth(result.data),
			checkedAt: result.data.checkedAt,
			services: result.data.services,
		};
	}
	if (
		result.error?.status === 503 &&
		isHealthResponse(result.error.value) &&
		result.error.value.status === 'partial'
	) {
		return {
			status: 'partial',
			checkedAt: result.error.value.checkedAt,
			services: result.error.value.services,
		};
	}
	return { status: 'down' };
}

export function usePwaAvailability(): PwaAvailability {
	const [availability, setAvailability] = useState<PwaAvailability>(() =>
		typeof navigator === 'undefined'
			? 'online'
			: getPwaAvailability(navigator.onLine),
	);

	useEffect(() => {
		const updateAvailability = () => {
			setAvailability(getPwaAvailability(navigator.onLine));
		};
		window.addEventListener('online', updateAvailability);
		window.addEventListener('offline', updateAvailability);
		return () => {
			window.removeEventListener('online', updateAvailability);
			window.removeEventListener('offline', updateAvailability);
		};
	}, []);

	return availability;
}

/**
 * Whether the API is up, asked once when the app opens and then only when
 * somebody asks again.
 *
 * There is no listener here at all, and that is the whole design. It used to
 * re-check on `online` and on every `visibilitychange`, which is not a poll but
 * behaves like one in ordinary use: each switch back to the tab spent a
 * request, so a window someone alt-tabs past all afternoon kept the serverless
 * container from ever falling asleep — the exact cost the no-polling rule
 * exists to avoid, arriving through the one hook that sat outside it.
 *
 * Nothing is lost by dropping them, because the answer was never trustworthy
 * between checks anyway: the API can go down one second after any of them. So
 * this reports when it last looked, and `recheck` is a button. Connectivity —
 * the thing that actually changes on its own — is `usePwaAvailability`, which
 * reads `navigator.onLine` and costs nothing.
 */
export function useApiHealth(): ApiHealth & { recheck: () => void } {
	const [health, setHealth] = useState<ApiHealth>({ status: 'loading' });
	// Survives re-renders so mashing the badge cannot open a request per click,
	// and so the mount check and a fast first click collapse into one.
	const inFlight = useRef(false);
	const isCurrent = useRef(true);

	const recheck = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		void api.health
			.get()
			.then((result) => {
				if (isCurrent.current) setHealth(getApiHealth(result));
			})
			.catch(() => {
				if (isCurrent.current) setHealth({ status: 'down' });
			})
			.finally(() => {
				inFlight.current = false;
			});
	}, []);

	useEffect(() => {
		isCurrent.current = true;
		recheck();
		return () => {
			isCurrent.current = false;
		};
	}, [recheck]);

	return { ...health, recheck };
}
