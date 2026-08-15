import { app } from '@api/index';

/** Dispatches a request in-process, without opening a port. */
export async function request(path: string, init?: RequestInit) {
	return app.handle(new Request(`http://localhost${path}`, init));
}

export async function json(path: string, method: string, body: unknown) {
	return request(path, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}
