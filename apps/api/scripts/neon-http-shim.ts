/**
 * Local stand-in for Neon's HTTP `/sql` endpoint: speaks the exact protocol
 * that `@neondatabase/serverless` uses in fetch mode, over a `pg` pool against
 * the Compose Postgres. It replaces `local-neon-http-proxy`, whose real
 * `neon-proxy` binary re-fetched SCRAM secrets from a mock control plane on
 * every request (~150 ms per query for a 0.6 ms query, ~125 s for the API
 * suite); the shim answers in single-digit milliseconds.
 *
 * Protocol, derived from `@neondatabase/serverless` 1.1.0 (`dist`):
 *
 * - Request body: `{query, params}` for a single query, `{queries: [...]}`
 *   for `transaction()` / Drizzle `db.batch`.
 * - `Neon-Raw-Text-Output: true` (always sent): values must be raw Postgres
 *   text; the driver parses them itself with its type parsers keyed by
 *   `fields[].dataTypeID`. Hence the identity type parsers below — `pg` must
 *   not parse anything.
 * - `Neon-Array-Mode: true` (always sent): rows come back as arrays; the
 *   driver builds objects itself from `fields[].name` when its caller asked
 *   for object rows.
 * - `Neon-Batch-Isolation-Level` / `Neon-Batch-Read-Only` /
 *   `Neon-Batch-Deferrable` shape the single transaction a batch runs in.
 * - Database errors must be HTTP **400** with the Postgres error fields as
 *   JSON: the driver only copies `code`, `detail`, `hint`, etc. onto
 *   `NeonDbError` for 400 responses — and the API discriminates on `code`
 *   (e.g. `23505`) — while any other status becomes a generic message.
 *
 * `Neon-Connection-String` is deliberately ignored: the shim listens on
 * loopback / the Compose-internal network only and always targets the single
 * local database from `PG_CONNECTION_STRING`, so parsing the header would add
 * code without adding protection.
 */
import pg from 'pg';

const PORT = 4444;

const connectionString = process.env.PG_CONNECTION_STRING;
if (!connectionString) {
	console.error('neon-http-shim: PG_CONNECTION_STRING is required');
	process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 10 });
pool.on('error', (error) => {
	console.error('neon-http-shim: idle client error', error.message);
});

/** Identity parsers: hand the driver raw Postgres text, never parsed values. */
const rawTextTypes: pg.CustomTypesConfig = {
	getTypeParser: () => (value: string) => value,
};

type WireQuery = { query: string; params: unknown[] };

const isWireQuery = (value: unknown): value is WireQuery => {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as { query?: unknown; params?: unknown };
	return typeof candidate.query === 'string' && Array.isArray(candidate.params);
};

const isBatchBody = (value: unknown): value is { queries: WireQuery[] } => {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as { queries?: unknown };
	return (
		Array.isArray(candidate.queries) && candidate.queries.every(isWireQuery)
	);
};

const runQuery = (
	executor: pg.Pool | pg.PoolClient,
	wire: WireQuery,
	rowAsArray: boolean,
) =>
	rowAsArray
		? executor.query({
				text: wire.query,
				values: wire.params,
				rowMode: 'array',
				types: rawTextTypes,
			})
		: executor.query({
				text: wire.query,
				values: wire.params,
				types: rawTextTypes,
			});

/** Only the fields the driver reads; shape mirrors Neon's `/sql` response. */
const toWireResult = (result: pg.QueryResult, rowAsArray: boolean) => ({
	command: result.command,
	rowCount: result.rowCount,
	fields: result.fields.map((field) => ({
		name: field.name,
		dataTypeID: field.dataTypeID,
	})),
	rows: result.rows,
	rowAsArray,
});

/** A request the shim itself rejects; rendered as 400 `{message}`. */
class ShimRequestError extends Error {}

const ISOLATION_LEVELS: Record<string, string> = {
	ReadUncommitted: 'READ UNCOMMITTED',
	ReadCommitted: 'READ COMMITTED',
	RepeatableRead: 'REPEATABLE READ',
	Serializable: 'SERIALIZABLE',
};

const beginStatement = (headers: Headers) => {
	const clauses = ['BEGIN'];
	const isolation = headers.get('neon-batch-isolation-level');
	if (isolation !== null) {
		const level = ISOLATION_LEVELS[isolation];
		if (level === undefined) {
			throw new ShimRequestError(`unknown isolation level: ${isolation}`);
		}
		clauses.push(`ISOLATION LEVEL ${level}`);
	}
	const readOnly = headers.get('neon-batch-read-only');
	if (readOnly !== null) {
		clauses.push(readOnly === 'true' ? 'READ ONLY' : 'READ WRITE');
	}
	const deferrable = headers.get('neon-batch-deferrable');
	if (deferrable !== null) {
		clauses.push(deferrable === 'true' ? 'DEFERRABLE' : 'NOT DEFERRABLE');
	}
	return clauses.join(' ');
};

/** One transaction for the whole batch, which `db.batch` semantics rely on. */
const runBatch = async (
	queries: WireQuery[],
	headers: Headers,
	rowAsArray: boolean,
) => {
	const begin = beginStatement(headers);
	const client = await pool.connect();
	try {
		await client.query(begin);
		const results = [];
		for (const wire of queries) {
			results.push(
				toWireResult(await runQuery(client, wire, rowAsArray), rowAsArray),
			);
		}
		await client.query('COMMIT');
		return results;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		client.release();
	}
};

const NEON_ERROR_FIELDS = [
	'severity',
	'code',
	'detail',
	'hint',
	'position',
	'internalPosition',
	'internalQuery',
	'where',
	'schema',
	'table',
	'column',
	'dataType',
	'constraint',
	'file',
	'line',
	'routine',
] as const;

const errorResponse = (error: unknown) => {
	if (error instanceof ShimRequestError) {
		return Response.json({ message: error.message }, { status: 400 });
	}
	if (error instanceof pg.DatabaseError) {
		const body: Record<string, unknown> = { message: error.message };
		for (const field of NEON_ERROR_FIELDS) body[field] = error[field];
		return Response.json(body, { status: 400 });
	}
	const message = error instanceof Error ? error.message : String(error);
	return Response.json({ message }, { status: 500 });
};

const handleSql = async (request: Request) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ message: 'request body is not valid JSON' },
			{ status: 400 },
		);
	}
	const rowAsArray = request.headers.get('neon-array-mode') === 'true';
	try {
		if (isBatchBody(body)) {
			const results = await runBatch(body.queries, request.headers, rowAsArray);
			return Response.json({ results });
		}
		if (isWireQuery(body)) {
			const result = await runQuery(pool, body, rowAsArray);
			return Response.json(toWireResult(result, rowAsArray));
		}
		return Response.json(
			{ message: 'expected {query, params} or {queries: [...]}' },
			{ status: 400 },
		);
	} catch (error) {
		return errorResponse(error);
	}
};

Bun.serve({
	port: PORT,
	hostname: '0.0.0.0',
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (request.method === 'GET' && pathname === '/health') {
			return Response.json({ status: 'ok' });
		}
		if (request.method === 'POST' && pathname === '/sql') {
			return handleSql(request);
		}
		return Response.json({ message: 'not found' }, { status: 404 });
	},
});

console.log(`neon-http-shim listening on :${PORT}`);
