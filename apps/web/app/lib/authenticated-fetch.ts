export type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type AuthenticatedFetchOptions = {
	fetcher: Fetcher;
	getAccessToken: () => string | null;
	refreshAccessToken: () => Promise<string | null>;
	onUnauthorized: () => void;
};

export function createAuthenticatedFetch({
	fetcher,
	getAccessToken,
	refreshAccessToken,
	onUnauthorized,
}: AuthenticatedFetchOptions): Fetcher {
	let refreshPromise: Promise<string | null> | null = null;

	return async (input, init) => {
		const request = async (accessToken: string | null) => {
			const headers = new Headers(init?.headers);
			if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
			return fetcher(input, { ...init, headers });
		};

		const response = await request(getAccessToken());
		if (response.status !== 401) return response;

		refreshPromise ??= refreshAccessToken()
			.catch(() => null)
			.finally(() => {
				refreshPromise = null;
			});
		const accessToken = await refreshPromise;
		if (!accessToken) {
			onUnauthorized();
			return response;
		}

		const retryResponse = await request(accessToken);
		if (retryResponse.status === 401) onUnauthorized();
		return retryResponse;
	};
}
