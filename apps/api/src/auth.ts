import { cache, env } from '@api/env';
import jwt from '@elysia/jwt';
import Elysia, { redirect } from 'elysia';
import { HttpError } from 'elysia-logger';
import { decodeIdToken, oauth2 } from 'elysia-oauth2';
import z from 'zod';

const jwtPayload = z.object({ email: z.email() });
const authQueryPayload = z.object({ redirect: z.url() });

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

const jwtPlugin = new Elysia()
	.use(
		jwt({
			name: 'jwt',
			exp: '12h',
			secret: env.LUKA_SECRET,
			schema: jwtPayload,
		}),
	)
	.use(
		jwt({
			name: 'refreshJwt',
			exp: '7d',
			secret: env.LUKA_SECRET,
			schema: jwtPayload,
		}),
	);

const googleRouter = new Elysia({ prefix: `/google` })
	.use(
		oauth2({
			Google: [
				env.GOOGLE_CLIENT_ID,
				env.GOOGLE_CLIENT_SECRET,
				`${env.DEPLOYMENT_URL}/auth/google/callback`,
			],
		}),
	)
	.use(jwtPlugin)
	.get(
		'/login',
		async ({ oauth2, query }) => {
			const redirectUrl = new URL(query.redirect);
			const callbackUrl = new URL('/auth/callback', env.WEB_URL);
			if (
				redirectUrl.origin !== callbackUrl.origin ||
				redirectUrl.pathname !== callbackUrl.pathname
			)
				throw new HttpError(422, 'INVALID_REDIRECT_ORIGIN');

			const url = oauth2.createURL('Google', ['openid', 'profile', 'email']);
			const state = url.searchParams.get('state');
			if (!state) throw new HttpError(409, 'STATE_NOT_FOUND');
			await cache.set(state, query, { ex: 900 });
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
				query.state,
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

			const signValue = { email: String(decoded.email) };
			const [at, rt] = await Promise.all([
				jwt.sign(signValue),
				refreshJwt.sign(signValue),
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
			if (!payload) throw new HttpError(401, 'INVALID_REFRESH_TOKEN');

			const signValue = { email: String(payload.email) };
			const [at, rt] = await Promise.all([
				jwt.sign(signValue),
				refreshJwt.sign(signValue),
			]);

			return { at, rt };
		},
		{
			detail: { summary: 'Refresh token' },
			body: z.object({ refreshToken: z.jwt() }),
		},
	);

export const authPlugin = (app: Elysia) =>
	app
		.use(jwtPlugin)
		.guard({
			headers: z.object({
				authorization: z.templateLiteral(['Bearer ', z.string()]).optional(),
			}),
		})
		.resolve(async ({ headers: { authorization }, jwt }) => {
			if (env.NODE_ENV !== 'production')
				return { authPayload: { email: 'dev@localhost' } };

			if (!authorization) throw new HttpError(401, 'MISSING_TOKEN');
			const payload = await jwt.verify(authorization.split(' ')[1]);
			if (!payload) throw new HttpError(401, 'INVALID_TOKEN');
			return { authPayload: payload };
		});
