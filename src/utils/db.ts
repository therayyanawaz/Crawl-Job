/**
 * src/utils/db.ts
 *
 * Singleton PostgreSQL connection pool for the crawl-job.
 *
 * All database access in the project goes through `query()` or the exported
 * `pool` object.  The pool is lazy — it does NOT connect until the first
 * query is made, so importing this module never blocks startup.
 *
 * Connection settings are read from environment variables at module load time:
 *   PGHOST      – default: localhost
 *   PGPORT      – default: 5432
 *   PGUSER      – required
 *   PGPASSWORD  – required
 *   PGDATABASE  – default: crawl_job
 *   PGSSL       – "true" to enable TLS (needed for managed DBs like Supabase, RDS)
 *
 * You can also set DATABASE_URL as a full connection string, which takes
 * priority over the individual variables.
 */

import pkg from 'pg';
const { Pool } = pkg;

// ─── Build connection config ────────────────────────────────────────────────

const connectionString = process.env.DATABASE_URL;

const poolConfig: ConstructorParameters<typeof Pool>[0] = connectionString
    ? {
        connectionString,
        ssl: connectionString.includes('sslmode=require') || process.env.PGSSL === 'true'
            ? { rejectUnauthorized: false }
            : undefined,
        max: Number(process.env.PG_POOL_MAX ?? 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    }
    : {
        host: process.env.PGHOST ?? 'localhost',
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE ?? 'crawl_job',
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
        max: Number(process.env.PG_POOL_MAX ?? 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    };

// ─── Singleton pool ─────────────────────────────────────────────────────────

export const pool = new Pool(poolConfig);

// Propagate unexpected pool errors to stderr instead of crashing the process
pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Execute a parameterised SQL query and return its result.
 *
 * @example
 *   const { rows } = await query('SELECT * FROM jobs WHERE source = $1', ['indeed']);
 */
export async function query<T extends pkg.QueryResultRow = pkg.QueryResultRow>(
    sql: string,
    values?: unknown[]
): Promise<pkg.QueryResult<T>> {
    return pool.query<T>(sql, values as any[]);
}

/**
 * Gracefully close the pool during process shutdown.
 * Call this in your cleanup / finally block.
 */
export async function closeDb(): Promise<void> {
    await pool.end();
}

/**
 * Quick connectivity smoke-test.
 * Returns true if the DB is reachable, false otherwise.
 */
export async function pingDb(): Promise<boolean> {
    try {
        await query('SELECT 1');
        return true;
    } catch {
        return false;
    }
}
