import type * as schema from '@api/schema';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createEnv } from '@t3-oss/env-core';
import { Redis } from '@upstash/redis';
import { S3Client } from 'bun';
import { upstashCache } from 'drizzle-orm/cache/upstash';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { z } from 'zod';

export const env = createEnv({
	server: {
		NODE_ENV: z
			.enum(['development', 'production', 'test'])
			.default('development'),
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
		NOVITA_API_KEY: z.string().min(1),
		ANTHROPIC_API_KEY: z.string().min(1),
		OPENAI_API_KEY: z.string().min(1),
		TAVILY_API_KEY: z.string().min(1),
		GOOGLE_CLIENT_ID: z.string().min(1),
		GOOGLE_CLIENT_SECRET: z.string().min(1),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});

if (env.NEON_FETCH_ENDPOINT) {
	neonConfig.fetchEndpoint = env.NEON_FETCH_ENDPOINT;
	neonConfig.useSecureWebSocket = false;
	neonConfig.poolQueryViaFetch = true;
}

const CACHE_CREDENTIALS = {
	url: env.UPSTASH_REDIS_REST_URL,
	token: env.UPSTASH_REDIS_REST_TOKEN,
};

export const cache = new Redis(CACHE_CREDENTIALS);

export const db = drizzle({
	client: neon(env.DATABASE_URL),
	cache: upstashCache({
		...CACHE_CREDENTIALS,
		global: true,
		config: { ex: 300 },
	}),
	casing: 'snake_case',
	logger: env.NODE_ENV !== 'production',
}) as NeonHttpDatabase<typeof schema>;

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
