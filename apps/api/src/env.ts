import * as schema from '@api/schema';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createEnv } from '@t3-oss/env-core';
import { Redis } from '@upstash/redis';
import { S3Client } from 'bun';
import { drizzle } from 'drizzle-orm/neon-http';
import { z } from 'zod';

export const env = createEnv({
	server: {
		/**
		 * Defaults to `production` so an environment that forgets to declare
		 * itself gets auth enforcement, security headers and quiet logs — never
		 * the development bypass. Every dev surface sets it explicitly: Compose
		 * defines `development`, `.env`/`.env.example` carry it for host runs,
		 * and `.env.test` declares `test`.
		 */
		NODE_ENV: z
			.enum(['development', 'production', 'test'])
			.default('production'),
		PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
		DEPLOYMENT_URL: z.url().default('http://localhost:8080'),
		LUKA_SECRET: z.string().min(1),
		ALLOWED_MAILS: z
			.array(z.email())
			.default([
				'lukacerrutti2002@gmail.com',
				'luka@tastewise.io',
				'luka.cerrutti@gds.ey.com',
			]),
		DATABASE_URL: z.url(),
		/**
		 * The official USD quote. Configurable so the tests can point it at a
		 * closed port and prove that recording an expense survives the feed being
		 * unreachable, instead of that assertion depending on the network.
		 */
		DOLARAPI_URL: z.url().default('https://dolarapi.com/v1/dolares/oficial'),
		NEON_FETCH_ENDPOINT: z.url().optional(),
		UPSTASH_REDIS_REST_URL: z.url(),
		UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
		S3_ENDPOINT: z.url(),
		/**
		 * The endpoint a browser can reach, when it differs from the one the API
		 * uses. SigV4 signs the host, so a URL signed for an internal name cannot
		 * be rewritten afterwards without invalidating the signature. Unset in
		 * production, where R2 answers on the same endpoint for both.
		 */
		S3_PUBLIC_ENDPOINT: z.url().optional(),
		S3_BUCKET: z.string().min(1).default('luka'),
		/** R2 ignores the region but SigV4 still signs it. MinIO accepts any value. */
		S3_REGION: z.string().min(1).default('auto'),
		S3_ACCESS_KEY_ID: z.string().min(1),
		S3_SECRET_ACCESS_KEY: z.string().min(1),
		GOOGLE_CLIENT_ID: z.string().min(1),
		GOOGLE_CLIENT_SECRET: z.string().min(1),
		/**
		 * LLM providers and web search for the Agent system. The local `.env`
		 * and `.env.test` carry dummy values: tests never call a provider, and
		 * in development a provider 401 is expected and surfaces inline.
		 */
		ANTHROPIC_API_KEY: z.string().min(1),
		GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
		OPENAI_API_KEY: z.string().min(1),
		NOVITA_API_KEY: z.string().min(1),
		TAVILY_API_KEY: z.string().min(1),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});

if (env.NEON_FETCH_ENDPOINT) {
	neonConfig.fetchEndpoint = env.NEON_FETCH_ENDPOINT;
	neonConfig.useSecureWebSocket = false;
	neonConfig.poolQueryViaFetch = true;
}

export const cache = new Redis({
	url: env.UPSTASH_REDIS_REST_URL,
	token: env.UPSTASH_REDIS_REST_TOKEN,
});

export const db = drizzle({
	client: neon(env.DATABASE_URL),
	/**
	 * The real schema object, not just its type: an assertion over a type-only
	 * import compiles the same but leaves `db.query.*` undefined at runtime.
	 */
	schema,
	casing: 'snake_case',
	/**
	 * Only development. Under `test` this logged every statement with its
	 * params, including whole note documents, which is tens of thousands of
	 * tokens of noise for anything reading the suite's output.
	 */
	logger: env.NODE_ENV === 'development',
});

export const storage = new S3Client({
	accessKeyId: env.S3_ACCESS_KEY_ID,
	secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	bucket: env.S3_BUCKET,
	endpoint: env.S3_ENDPOINT,
});

/**
 * Signs URLs the browser follows. Identical to `storage` except for the
 * endpoint, which has to be one the browser can actually resolve.
 */
export const presigner = env.S3_PUBLIC_ENDPOINT
	? new S3Client({
			accessKeyId: env.S3_ACCESS_KEY_ID,
			secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			bucket: env.S3_BUCKET,
			endpoint: env.S3_PUBLIC_ENDPOINT,
		})
	: storage;
