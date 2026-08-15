import { cache, db, env, storage } from '@api/env';
import cors from '@elysia/cors';
import openapi, { fromTypes } from '@elysia/openapi';
import Elysia from 'elysia';
import { helmet } from 'elysia-helmet';
import { logger } from 'elysia-logger';
import { z } from 'zod';
import { authRouter } from './auth';
import { credentialsRouter } from './credentials';
import { eventsRouter } from './events';
import { filesRouter } from './files';
import { notesRouter } from './notes';
import { paymentsRouter } from './payments';
import { publicFilesRouter } from './public-files';
import { publicNotesRouter } from './public-notes';

export const app = new Elysia()
	.onError(({ code, error, status }) => {
		if (code === 'VALIDATION')
			return status(422, { error: 'VALIDATION_ERROR' });
		const databaseError = error as {
			code?: string;
			cause?: { code?: string };
		};
		if (databaseError.code === '23505' || databaseError.cause?.code === '23505')
			return status(409, { error: 'UNIQUE_CONSTRAINT_VIOLATION' });
	})
	.use(
		// `ETag` is not a header the browser hands to JavaScript on its own, so a
		// cross-origin client cannot revalidate without being told it may read it.
		cors({ exposeHeaders: ['etag'] }),
	)
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
			level: env.NODE_ENV === 'development' ? 'debug' : 'warn',
			/**
			 * Two INFO lines per request, and `level` cannot turn them off: with the
			 * console transport `Logger.log` writes straight to the stream and never
			 * consults pino. `autoLogging` is the only switch the plugin checks, and
			 * it leaves `onError` alone, so warnings and exceptions still surface.
			 */
			autoLogging: env.NODE_ENV === 'development',
			logDetails: false,
		}),
	)
	.use(authRouter)
	.use(credentialsRouter)
	.use(eventsRouter)
	.use(filesRouter)
	.use(notesRouter)
	.use(paymentsRouter)
	.use(publicFilesRouter)
	.use(publicNotesRouter)
	.get(
		'/health',
		async ({ status }) => {
			const [dbCheck, cacheCheck, storageCheck] = await Promise.all([
				db
					.execute('SELECT true')
					.then(() => true)
					.catch(() => false),
				cache
					.exec(['PING'])
					.then((result) => result === 'PONG')
					.catch(() => false),
				storage
					.list({ maxKeys: 1 })
					.then(() => true)
					.catch(() => false),
			]);

			const services = { dbCheck, cacheCheck, storageCheck };
			const isOperational = Object.values(services).every(Boolean);

			const response = {
				status: isOperational ? 'operational' : 'partial',
				checkedAt: new Date().toISOString(),
				services,
			};

			return isOperational ? response : status(503, response);
		},
		{ detail: { summary: 'Health check' } },
	);

export type App = typeof app;

if (import.meta.main) app.listen(env.PORT);
