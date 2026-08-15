import { cache, env } from '@api/env';
import jwt from '@elysia/jwt';
import Elysia, { redirect } from 'elysia';
import { HttpError } from 'elysia-logger';
import { decodeIdToken, oauth2 } from 'elysia-oauth2';
import z from 'zod';

/**
 * Access and refresh tokens share the secret and the email claim, so the `typ`
 * claim is the only thing keeping them from being interchangeable — without it
 * a 12-hour access token doubles as a 7-day refresh token. `authPlugin` only
 * accepts `access`; `/auth/refresh-token` only accepts `refresh`.
 *
 * Each verification site checks the claim explicitly: the plugin's `schema`
 * types `sign`/`verify` but does **not** reject a mismatching payload at
 * runtime (verified empirically — a wrong `typ` sails through `verify`), so
 * the literal here is documentation and typing, never enforcement.
 */
const accessPayload = z.object({ email: z.email(), typ: z.literal('access') });
const refreshPayload = z.object({
	email: z.email(),
	typ: z.literal('refresh'),
});
const authQueryPayload = z.object({ redirect: z.url() });

/** Prefixed so it can never collide with anything else on this shared Redis. */
const stateKey = (state: string) => `auth:state:${state}`;

export function createSessionRedirect(
	redirectUrl: string,
	session: { at: string; rt: string },
) {
	const url = new URL(redirectUrl);
	url.hash = new URLSearchParams({
		session: btoa(JSON.stringify(session)),
	}).toString();
	return url.href;
}

export const jwtPlugin = new Elysia()
	.use(
		jwt({
			name: 'jwt',
			exp: '12h',
			secret: env.LUKA_SECRET,
			schema: accessPayload,
		}),
	)
	.use(
		jwt({
			name: 'refreshJwt',
			exp: '7d',
			secret: env.LUKA_SECRET,
			schema: refreshPayload,
		}),
	);

const googleRouter = new Elysia({ prefix: `/google` })
	.use(
		oauth2(
			{
				Google: [
					env.GOOGLE_CLIENT_ID,
					env.GOOGLE_CLIENT_SECRET,
					`${env.DEPLOYMENT_URL}/auth/google/callback`,
				],
			},
			{
				cookie: { secure: env.NODE_ENV === 'production' },
			},
		),
	)
	.use(jwtPlugin)
	.get(
		'/login',
		async ({ oauth2, query }) => {
			const url = oauth2.createURL('Google', ['openid', 'profile', 'email']);
			const state = url.searchParams.get('state');
			if (!state) throw new HttpError(409, 'STATE_NOT_FOUND');
			await cache.set(stateKey(state), query, { ex: 900 });
			return redirect(url.href);
		},
		{
			detail: { summary: 'Google OAuth (login)' },
			query: authQueryPayload,
		},
	)
	.get(
		'/callback',
		async ({ oauth2, query, jwt, refreshJwt }) => {
			const q = await cache.getdel<z.infer<typeof authQueryPayload>>(
				stateKey(query.state),
			);
			if (!q) throw new HttpError(412, 'STATE_NOT_FOUND');

			const decoded = decodeIdToken(
				(await oauth2.authorize('Google')).idToken(),
			);

			if (
				!('email' in decoded) ||
				!env.ALLOWED_MAILS.includes(String(decoded.email))
			)
				throw new HttpError(403, 'EMAIL_NOT_ALLOWED');

			const email = String(decoded.email);
			const [at, rt] = await Promise.all([
				jwt.sign({ email, typ: 'access' }),
				refreshJwt.sign({ email, typ: 'refresh' }),
			]);

			return redirect(createSessionRedirect(q.redirect, { at, rt }));
		},
		{
			detail: { summary: 'Google OAuth Callback', hide: true },
		},
	);

export const authRouter = new Elysia({ prefix: '/auth', tags: ['Auth'] })
	.use(googleRouter)
	.post(
		'/refresh-token',
		async ({ body: { refreshToken }, refreshJwt, jwt }) => {
			const payload = await refreshJwt.verify(refreshToken);
			// The explicit claim check is what refuses an access token here; the
			// plugin schema alone would let it through.
			if (payload === false || payload.typ !== 'refresh')
				throw new HttpError(401, 'INVALID_REFRESH_TOKEN');

			const email = String(payload.email);
			const [at, rt] = await Promise.all([
				jwt.sign({ email, typ: 'access' }),
				refreshJwt.sign({ email, typ: 'refresh' }),
			]);

			return { at, rt };
		},
		{
			detail: { summary: 'Refresh token' },
			body: z.object({ refreshToken: z.jwt() }),
		},
	);

/**
 * Factory over the mode so the tests can build the `production` variant and
 * exercise the enforcement branches, which under `.env.test` are otherwise
 * unreachable. The application only ever uses `authPlugin` below; the bypass
 * stays inside this function and must not be reproduced elsewhere.
 */
export const createAuthPlugin =
	(mode: (typeof env)['NODE_ENV']) => (app: Elysia) =>
		app
			.use(jwtPlugin)
			.guard({
				headers: z.object({
					authorization: z.templateLiteral(['Bearer ', z.string()]).optional(),
				}),
			})
			.resolve(async ({ headers: { authorization }, jwt }) => {
				if (mode !== 'production')
					return { authPayload: { email: 'dev@localhost' } };

				if (!authorization) throw new HttpError(401, 'MISSING_TOKEN');
				const payload = await jwt.verify(authorization.split(' ')[1]);
				// The explicit claim check is what refuses a refresh token used as a
				// bearer; the plugin schema alone would let it through.
				if (payload === false || payload.typ !== 'access')
					throw new HttpError(401, 'INVALID_TOKEN');
				return { authPayload: payload };
			});

export const authPlugin = createAuthPlugin(env.NODE_ENV);
