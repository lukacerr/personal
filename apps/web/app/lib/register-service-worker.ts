type ServiceWorkerContainerLike = {
	register: (scriptURL: string) => Promise<{ update: () => Promise<unknown> }>;
};

export async function registerServiceWorker(
	serviceWorker: ServiceWorkerContainerLike,
) {
	try {
		const registration = await serviceWorker.register('/sw.js');
		await registration.update();
	} catch {
		// An offline startup can race service worker registration.
	}
}
