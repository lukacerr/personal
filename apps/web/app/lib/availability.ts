import { api } from '@web/lib/api';
import { useEffect, useState } from 'react';

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

export function useApiHealth(): ApiHealth {
	const [health, setHealth] = useState<ApiHealth>({ status: 'loading' });

	// One check at mount goes stale the moment the laptop sleeps or the tab is
	// backgrounded. Coming back online or to the foreground re-asks — the two
	// moments the answer can have changed — with no continuous polling.
	useEffect(() => {
		let isCurrent = true;
		let inFlight = false;
		const check = () => {
			if (inFlight) return;
			inFlight = true;
			void api.health
				.get()
				.then((result) => {
					if (isCurrent) setHealth(getApiHealth(result));
				})
				.catch(() => {
					if (isCurrent) setHealth({ status: 'down' });
				})
				.finally(() => {
					inFlight = false;
				});
		};
		const handleVisibility = () => {
			if (document.visibilityState === 'visible') check();
		};

		check();
		window.addEventListener('online', check);
		document.addEventListener('visibilitychange', handleVisibility);
		return () => {
			isCurrent = false;
			window.removeEventListener('online', check);
			document.removeEventListener('visibilitychange', handleVisibility);
		};
	}, []);

	return health;
}
