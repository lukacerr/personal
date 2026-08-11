/**
 * Replaces the local database with a fresh copy of production.
 *
 * One-way and destructive by design: the local `public` schema is dropped and
 * rebuilt from a production dump, so a local database broken by experiments can
 * be reset to a state that is known to work. Nothing is ever written back to
 * production.
 *
 * Two things keep a mistake from being expensive. The dump is taken before
 * anything local is touched, so a failed dump leaves the local database exactly
 * as it was, and the drop plus restore run inside a single transaction, so a
 * failed restore rolls back instead of leaving an empty database behind.
 *
 * What arrives is not quite production: the tables in `SECRET_TABLES` are emptied
 * at the end of the same transaction, because their rows are sealed with a secret
 * only production holds and would land here as envelopes nothing can open.
 *
 * The two `DATABASE_URL`s are read straight from the env files rather than
 * through `@api/env`: this needs both at once, and `@api/env` would demand the
 * whole production secret set just to hand back one value.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_ROOT = join(import.meta.dir, '..');
const SOURCE_ENV = join(API_ROOT, '.env.production');
const TARGET_ENV = join(API_ROOT, '.env');

/** The only hosts a wipe may point at. Anything else is refused outright. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'db']);

function parseEnvFile(contents: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of contents.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const separator = trimmed.indexOf('=');
		if (separator === -1) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		values[key] = value.replace(/^(['"])(.*)\1$/, '$2');
	}
	return values;
}

export function readDatabaseUrl(contents: string, source: string): URL {
	const value = parseEnvFile(contents).DATABASE_URL;
	if (!value) throw new Error(`${source} has no DATABASE_URL.`);
	try {
		return new URL(value);
	} catch {
		throw new Error(`${source} has a DATABASE_URL that is not a valid URL.`);
	}
}

/** `URL` brackets IPv6 hosts; libpq and the allowlist both want them bare. */
function hostOf(url: URL): string {
	return url.hostname.replace(/^\[(.*)]$/, '$1');
}

export function assertLocalTarget(url: URL): void {
	const host = hostOf(url);
	if (!LOCAL_HOSTS.has(host))
		throw new Error(
			`Refusing to wipe ${host}: the target database must be a local one.`,
		);
}

/**
 * Neon's pooled endpoint is PgBouncer in transaction mode, which cannot serve
 * the session-level work `pg_dump` does, so the dump goes through the direct
 * endpoint instead.
 */
export function toDumpUrl(url: URL): URL {
	const direct = new URL(url.toString());
	direct.hostname = direct.hostname.replace(/-pooler(?=\.)/, '');
	if (
		direct.hostname.endsWith('.neon.tech') &&
		!direct.searchParams.has('sslmode')
	)
		direct.searchParams.set('sslmode', 'require');
	return direct;
}

/**
 * Splits the password out of the connection string. libpq reads it from
 * `PGPASSWORD`, and keeping it out of argv keeps it out of `ps`.
 */
export function toConnection(url: URL): { conninfo: string; password: string } {
	const conninfo = new URL(url.toString());
	const password = decodeURIComponent(conninfo.password);
	conninfo.password = '';
	return { conninfo: conninfo.toString(), password };
}

/**
 * Whether the dump rebuilds `public` on its own. Which server versions and
 * ownership setups make `pg_dump` emit it varies, and creating that schema
 * twice fails the restore just as hard as never creating it at all.
 */
export function dumpCreatesPublicSchema(sql: string): boolean {
	return /^CREATE SCHEMA (IF NOT EXISTS )?public;/m.test(sql);
}

/**
 * Tables whose rows are encrypted with a secret only production holds, and are
 * therefore worthless locally: the envelopes come back undecryptable, and the
 * screen would be a wall of rows nobody can open. They are emptied rather than
 * left as noise. Any future system that seals rows with `LUKA_SECRET` belongs
 * here too.
 *
 * Notes that referenced a credential are left alone on purpose. Their blocks
 * carry the id and report a reference that is gone, which is exactly what the
 * local copy should say.
 */
const SECRET_TABLES = ['credential'];

/**
 * Schema-qualified because the dump ends with `search_path` set to nothing.
 *
 * `pg_dump` emits `set_config('search_path', '', false)` and creates everything
 * fully qualified, and that setting outlives the file: an unqualified statement
 * afterwards fails with `relation "credential" does not exist` even though
 * `public.credential` was just created. `public` is already hardcoded either side
 * of this, in the drop and the create.
 */
const wipeStatement = (table: string) => `DELETE FROM public.${table}`;

/**
 * The arguments for the restore, in the order `psql` will act on them.
 *
 * `--command` and `--file` are processed in the order they appear, so this
 * ordering *is* the behaviour, and moving a wipe earlier breaks it in one of two
 * ways. Before the dump but after the schema was recreated, it errors on a table
 * that does not exist yet and takes the whole restore down with it. Before the
 * drop, it succeeds against the rows it was about to replace and then production's
 * arrive intact — no error, no output, and every secret now sits in the local
 * database. Both were checked against a real `psql`; the second is the reason this
 * function exists to be tested rather than being inlined.
 *
 * All of it inside one transaction, so a failed wipe rolls the restore back rather
 * than leaving those rows behind.
 */
export function restoreArgs(
	dumpPath: string,
	dumpSql: string,
	conninfo: string,
): string[] {
	const command = (statement: string) => ['--command', statement];
	const before = ['DROP SCHEMA IF EXISTS public CASCADE'];
	if (!dumpCreatesPublicSchema(dumpSql)) before.push('CREATE SCHEMA public');

	return [
		'--quiet',
		'--single-transaction',
		'--set=ON_ERROR_STOP=1',
		...before.flatMap(command),
		`--file=${dumpPath}`,
		...SECRET_TABLES.flatMap((table) => command(wipeStatement(table))),
		conninfo,
	];
}

async function pg(
	binary: string,
	args: string[],
	password: string,
	stdout: 'inherit' | 'ignore' = 'inherit',
): Promise<void> {
	const child = Bun.spawn([binary, ...args], {
		env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '30' },
		stdout,
		stderr: 'inherit',
	});
	const code = await child.exited;
	if (code !== 0) throw new Error(`${binary} exited with code ${code}.`);
}

async function main(): Promise<void> {
	for (const binary of ['pg_dump', 'psql'])
		if (!Bun.which(binary))
			throw new Error(
				`${binary} is not on PATH. Install the PostgreSQL client tools.`,
			);

	const source = toDumpUrl(
		readDatabaseUrl(await Bun.file(SOURCE_ENV).text(), '.env.production'),
	);
	const target = readDatabaseUrl(await Bun.file(TARGET_ENV).text(), '.env');
	assertLocalTarget(target);

	const from = toConnection(source);
	const into = toConnection(target);

	// Reaching the target first turns "the stack is down" into that error rather
	// than one that only surfaces after a full production dump.
	await pg(
		'psql',
		['--quiet', '--tuples-only', '--command', 'SELECT 1', into.conninfo],
		into.password,
		'ignore',
	);

	const workspace = await mkdtemp(join(tmpdir(), 'personal-db-pull-'));
	const dumpPath = join(workspace, 'production.sql');
	try {
		console.info(`Dumping ${hostOf(source)}${source.pathname}…`);
		await pg(
			'pg_dump',
			[
				'--no-owner',
				'--no-privileges',
				'--format=plain',
				`--file=${dumpPath}`,
				from.conninfo,
			],
			from.password,
		);

		console.info(`Replacing ${hostOf(target)}${target.pathname}…`);
		await pg(
			'psql',
			restoreArgs(dumpPath, await Bun.file(dumpPath).text(), into.conninfo),
			into.password,
			// The dump drives `set_config` and `setval` through SELECT, whose result
			// tables are noise. Errors and notices go to stderr and still show.
			'ignore',
		);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}

	console.info(
		`Local database now mirrors production, without ${SECRET_TABLES.join(', ')}.`,
	);
}

if (import.meta.main)
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
