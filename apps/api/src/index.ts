import { cache, db, env, storage } from '@api/env';
import cors from '@elysia/cors';
import openapi, { fromTypes } from '@elysia/openapi';
import Elysia from 'elysia';
import { helmet } from 'elysia-helmet';
import { logger } from 'elysia-logger';
import { z } from 'zod';
import { authRouter } from './auth';

export const app = new Elysia()
	.use(cors())
	.use(
		env.NODE_ENV === 'development' &&
			openapi({
				path: '/docs',
				mapJsonSchema: { zod: z.toJSONSchema },
				references: fromTypes(),
				scalar: {
					defaultOpenAllTags: true,
					expandAllModelSections: true,
					theme: 'elysiajs',
					expandAllResponses: true,
					hideClientButton: true,
					hideDarkModeToggle: true,
					persistAuth: true,
				},
				documentation: {
					info: {
						title: "Luka's personal API",
						version: '1.0.0',
						license: {
							name: 'Attribution-NonCommercial-NoDerivatives 4.0 International',
							url: 'https://creativecommons.org/licenses/by-nc-nd/4.0',
						},
					},
					servers: [
						{
							url: `http://localhost:${env.PORT ?? 8080}`,
							description: 'Local',
						},
						{ url: 'https://api.luka.software', description: 'Production' },
					],
				},
			}),
	)
	.use(env.NODE_ENV === 'production' && helmet())
	.use(
		logger({
			level: env.NODE_ENV === 'production' ? 'warn' : 'debug',
			logDetails: true,
		}),
	)
	.use(authRouter)
	.get(
		'/health',
		async () => ({
			timestamp: new Date().toISOString(),
			dbResponse: JSON.stringify(await db.execute('SELECT true')),
			cacheResponse: (await cache.exec(['PING'])) as 'PONG',
			storageResponse: await storage.list({ maxKeys: 1 }),
		}),
		{ detail: { summary: 'Health check' } },
	);

export type App = typeof app;

if (import.meta.main) app.listen(env.PORT);
