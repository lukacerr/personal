import { type Config, defineConfig } from 'drizzle-kit';
import { z } from 'zod';

// El config de migraciones se mantiene desacoplado de `@api/env` a propósito:
// solo necesita la URL de la base de datos. Así drizzle-kit no arrastra los
// clientes runtime (S3/Redis/etc.) ni exige el resto de secretos, y el workflow
// de migraciones en CI puede correr únicamente con `DATABASE_URL`.
const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);

export default defineConfig({
	verbose: true,
	dialect: 'postgresql',
	schema: './src/schema/index.ts',
	out: './migrations',
	casing: 'snake_case',

	migrations: {
		prefix: 'timestamp',
		table: '__migrations',
		schema: 'public',
	},

	breakpoints: false,
	strict: true,

	dbCredentials: {
		url: DATABASE_URL,
	},
}) satisfies Config;
