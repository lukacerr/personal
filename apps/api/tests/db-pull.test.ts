import { describe, expect, it } from 'bun:test';
import {
	assertLocalTarget,
	dumpCreatesPublicSchema,
	readDatabaseUrl,
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
