type ServiceWorkerContainerLike = {
	controller: unknown | null;
	register: (
		scriptURL: string,
		options: { updateViaCache: 'none' },
	) => Promise<{ update: () => Promise<unknown> }>;
	addEventListener: (type: 'controllerchange', listener: () => void) => void;
	removeEventListener: (type: 'controllerchange', listener: () => void) => void;
};

type VisibilityDocumentLike = {
	readonly visibilityState: string;
	addEventListener: (type: 'visibilitychange', listener: () => void) => void;
	removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
};

export async function registerServiceWorker(
	serviceWorker: ServiceWorkerContainerLike,
	reload = () => window.location.reload(),
	visibilityDocument?: VisibilityDocumentLike,
) {
	const currentDocument =
		visibilityDocument ??
		(typeof document === 'undefined' ? undefined : document);
	let hasController = serviceWorker.controller !== null;
	let isReloading = false;
	const handleControllerChange = () => {
		if (!hasController) {
			hasController = true;
			return;
		}
		if (isReloading) return;

		isReloading = true;
		reload();
	};

	serviceWorker.addEventListener('controllerchange', handleControllerChange);
	let removeVisibilityListener = () => {};

	try {
		const registration = await serviceWorker.register('/sw.js', {
			updateViaCache: 'none',
		});
		const handleVisibilityChange = () => {
			if (currentDocument?.visibilityState === 'visible') {
				void registration.update().catch(() => undefined);
			}
		};
		if (currentDocument) {
			currentDocument.addEventListener(
				'visibilitychange',
				handleVisibilityChange,
			);
			removeVisibilityListener = () => {
				currentDocument.removeEventListener(
					'visibilitychange',
					handleVisibilityChange,
				);
			};
		}
		await registration.update();
	} catch {
		// An offline startup can race service worker registration.
	}

	return () => {
		removeVisibilityListener();
		serviceWorker.removeEventListener(
			'controllerchange',
			handleControllerChange,
		);
	};
}
