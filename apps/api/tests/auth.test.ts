import { describe, expect, it } from 'bun:test';
import { createAuthPlugin, jwtPlugin } from '@api/auth';
import { cache } from '@api/env';
import { app } from '@api/index';
import Elysia from 'elysia';
import { HttpError } from 'elysia-logger';
import { json } from './helpers';

const EMAIL = 'test@localhost';

/** Mints the same token pair the OAuth callback would, without a browser. */
const minter = new Elysia()
	.use(jwtPlugin)
	.get('/mint', async ({ jwt, refreshJwt }) => ({
		at: await jwt.sign({ email: EMAIL, typ: 'access' }),
		rt: await refreshJwt.sign({ email: EMAIL, typ: 'refresh' }),
	}));

async function mint() {
	const response = await minter.handle(new Request('http://localhost/mint'));
	return (await response.json()) as { at: string; rt: string };
}

/**
 * A private route with enforcement on. Under `.env.test` the real routers run
 * with the development bypass, so the production variant of the plugin is the
 * only way to reach the branches that actually guard the deployment. The
 * `onError` mirrors the `HttpError` mapping `elysia-logger` performs in
 * `index.ts`, without its output.
 */
const guarded = new Elysia()
	.onError(({ error, set }) => {
		if (error instanceof HttpError) {
			set.status = error.status;
			return error.toJSON();
		}
	})
	.use(createAuthPlugin('production'))
	.get('/private', ({ authPayload }) => authPayload);

async function privateRequest(token?: string) {
	return guarded.handle(
		new Request('http://localhost/private', {
			headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
		}),
	);
}

/**
 * Flips a character of the signature, keeping the JWT well-formed. Never the
 * final one: base64url of a 32-byte signature leaves the last character with
 * two padding bits that decoders ignore, so flipping only those bits yields a
 * token that still verifies. Every earlier character is all significant bits.
 */
function tampered(token: string) {
	const flipped = token.at(-2) === 'A' ? 'B' : 'A';
	return token.slice(0, -2) + flipped + token.slice(-1);
}

describe('refresh token endpoint', () => {
	it('answers a valid refresh with a working access/refresh pair', async () => {
		const { rt } = await mint();

		const response = await json('/auth/refresh-token', 'POST', {
			refreshToken: rt,
		});
		expect(response.status).toBe(200);
		const pair = (await response.json()) as { at: string; rt: string };

		// The new access token opens a private route...
		const opened = await privateRequest(pair.at);
		expect(opened.status).toBe(200);
		expect(await opened.json()).toMatchObject({ email: EMAIL, typ: 'access' });

		// ...and the new refresh token refreshes again.
		const again = await json('/auth/refresh-token', 'POST', {
			refreshToken: pair.rt,
		});
		expect(again.status).toBe(200);
	});

	it('refuses a token with a broken signature', async () => {
		const { rt } = await mint();
		const response = await json('/auth/refresh-token', 'POST', {
			refreshToken: tampered(rt),
		});
		expect(response.status).toBe(401);
	});

	/**
	 * Both tokens share the secret and the email claim; the `typ` claim is the
	 * only thing keeping a 12-hour access token from acting as a 7-day refresh
	 * token.
	 */
	it('refuses an access token presented as a refresh token', async () => {
		const { at } = await mint();
		const response = await json('/auth/refresh-token', 'POST', {
			refreshToken: at,
		});
		expect(response.status).toBe(401);
	});
});

describe('authPlugin enforcement', () => {
	it('refuses a request with no token', async () => {
		expect((await privateRequest()).status).toBe(401);
	});

	it('refuses garbage as a bearer token', async () => {
		expect((await privateRequest('garbage')).status).toBe(401);
	});

	/** The mirror of the `typ` rule: a refresh token opens nothing by itself. */
	it('refuses a refresh token used as a bearer token', async () => {
		const { rt } = await mint();
		expect((await privateRequest(rt)).status).toBe(401);
	});
});

describe('oauth state', () => {
	it('scopes the state under its own prefix in the shared cache', async () => {
		const redirect = 'http://localhost:5173/auth/callback';
		const response = await app.handle(
			new Request(
				`http://localhost/auth/google/login?redirect=${encodeURIComponent(redirect)}`,
			),
		);
		expect(response.status).toBe(302);

		const location = response.headers.get('location');
		const state = new URL(location ?? '').searchParams.get('state');
		expect(state).toBeTruthy();
		// `getdel` also cleans the entry up so the suite leaves nothing behind.
		expect(await cache.getdel(`auth:state:${state}`)).toMatchObject({
			redirect,
		});
	});
});
