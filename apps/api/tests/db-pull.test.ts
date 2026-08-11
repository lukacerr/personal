import { describe, expect, it } from 'bun:test';
import {
	assertLocalTarget,
	dumpCreatesPublicSchema,
	readDatabaseUrl,
	restoreArgs,
	toConnection,
	toDumpUrl,
} from '@api/scripts/db-pull';

describe('readDatabaseUrl', () => {
	it('reads the URL past comments, blank lines and quotes', () => {
		const url = readDatabaseUrl(
			[
				'# local database',
				'',
				'PORT=8080',
				'DATABASE_URL="postgres://user:pass@localhost:5432/personal"',
			].join('\n'),
			'.env',
		);

		expect(url.hostname).toBe('localhost');
		expect(url.pathname).toBe('/personal');
	});

	it('names the file it could not read a URL from', () => {
		expect(() => readDatabaseUrl('PORT=8080', '.env.production')).toThrow(
			'.env.production',
		);
	});
});

describe('assertLocalTarget', () => {
	it.each(['localhost', '127.0.0.1', 'db'])('accepts %s', (host) => {
		expect(() =>
			assertLocalTarget(new URL(`postgres://user@${host}:5432/personal`)),
		).not.toThrow();
	});

	it('refuses to wipe anything that is not local', () => {
		expect(() =>
			assertLocalTarget(
				new URL('postgres://user@ep-a-pooler.us-east-1.aws.neon.tech/personal'),
			),
		).toThrow('ep-a-pooler.us-east-1.aws.neon.tech');
	});
});

describe('toDumpUrl', () => {
	it('dumps through the direct endpoint instead of the pooler', () => {
		const url = toDumpUrl(
			new URL(
				'postgres://user:pass@ep-a-pooler.c-11.us-east-1.aws.neon.tech/personal?channel_binding=require',
			),
		);

		expect(url.hostname).toBe('ep-a.c-11.us-east-1.aws.neon.tech');
		expect(url.searchParams.get('channel_binding')).toBe('require');
		expect(url.searchParams.get('sslmode')).toBe('require');
		expect(url.password).toBe('pass');
	});

	it('leaves a local URL alone', () => {
		const url = toDumpUrl(
			new URL('postgres://user:pass@localhost:5432/personal'),
		);

		expect(url.hostname).toBe('localhost');
		expect(url.searchParams.get('sslmode')).toBeNull();
	});
});

describe('toConnection', () => {
	it('keeps the password out of argv', () => {
		const { conninfo, password } = toConnection(
			new URL('postgres://user:s%3Acret@localhost:5432/personal'),
		);

		expect(conninfo).not.toContain('cret');
		expect(conninfo).toContain('user@localhost:5432/personal');
		expect(password).toBe('s:cret');
	});
});

describe('dumpCreatesPublicSchema', () => {
	it('detects the schema the dump rebuilds itself', () => {
		expect(dumpCreatesPublicSchema('SET x = 1;\nCREATE SCHEMA public;\n')).toBe(
			true,
		);
	});

	it('does not mistake a table in public for the schema', () => {
		expect(
			dumpCreatesPublicSchema('CREATE TABLE public.note (id uuid);\n'),
		).toBe(false);
	});
});

describe('restoreArgs', () => {
	const argsFor = (dumpSql: string) =>
		restoreArgs(
			'/tmp/production.sql',
			dumpSql,
			'postgres://localhost/personal',
		);

	/**
	 * `psql` acts on `--command` and `--file` in the order they appear, so this
	 * ordering is the whole behaviour. A wipe moved ahead of the drop deletes the
	 * rows it was about to replace, then production's arrive intact — no error and
	 * no output, with every secret now in the local database.
	 */
	it('wipes the secret tables after the dump has been replayed', () => {
		const args = argsFor('CREATE SCHEMA public;\n');
		const file = args.indexOf('--file=/tmp/production.sql');
		const wipe = args.indexOf('DELETE FROM public.credential');

		expect(file).toBeGreaterThan(-1);
		expect(wipe).toBeGreaterThan(file);
		expect(args[wipe - 1]).toBe('--command');
	});

	/**
	 * `pg_dump` ends the file with `set_config('search_path', '', false)`, and that
	 * outlives it: an unqualified statement afterwards fails with `relation
	 * "credential" does not exist` even though `public.credential` was created a
	 * moment earlier. This cost a failed pull to find.
	 */
	it('qualifies the wipe with the schema the dump leaves out of search_path', () => {
		const wipes = argsFor('CREATE SCHEMA public;\n').filter((argument) =>
			argument.startsWith('DELETE FROM'),
		);

		expect(wipes).not.toHaveLength(0);
		for (const wipe of wipes) expect(wipe).toStartWith('DELETE FROM public.');
	});

	it('drops the schema before the dump replays', () => {
		const args = argsFor('CREATE SCHEMA public;\n');
		expect(args.indexOf('DROP SCHEMA IF EXISTS public CASCADE')).toBeLessThan(
			args.indexOf('--file=/tmp/production.sql'),
		);
	});

	/** A failed wipe has to take the restore down with it, not leave those rows. */
	it('runs the whole restore in one transaction that stops on error', () => {
		const args = argsFor('CREATE SCHEMA public;\n');
		expect(args).toContain('--single-transaction');
		expect(args).toContain('--set=ON_ERROR_STOP=1');
	});

	it('creates the schema only when the dump does not', () => {
		expect(argsFor('CREATE SCHEMA public;\n')).not.toContain(
			'CREATE SCHEMA public',
		);
		expect(argsFor('CREATE TABLE public.note (id uuid);\n')).toContain(
			'CREATE SCHEMA public',
		);
	});

	it('ends with the connection string, as psql expects', () => {
		expect(argsFor('CREATE SCHEMA public;\n').at(-1)).toBe(
			'postgres://localhost/personal',
		);
	});
});
