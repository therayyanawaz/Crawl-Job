/**
 * src/db/migrate.ts
 *
 * Idempotent database migration for the job-crawler.
 * Schema aligned with STRATEGY.md § 8.
 *
 * Run:  npm run db:migrate
 *
 * Uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS —
 * completely safe to run multiple times without data loss.
 * Also runs ALTER TABLE ADD COLUMN IF NOT EXISTS for new columns
 * so existing data is preserved when the schema grows.
 */

import { query, closeDb, pingDb } from '../utils/db.js';
import 'dotenv/config';

// ─── Schema ─────────────────────────────────────────────────────────────────

const CREATE_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS jobs (
    id             BIGSERIAL PRIMARY KEY,

    -- Platform identity
    platform       TEXT        NOT NULL DEFAULT 'unknown',
    platform_job_id TEXT,                                      -- Platform's own ID (dedup helper)

    -- Core identity
    url            TEXT        NOT NULL,
    apply_url      TEXT,                                        -- Direct application link
    title          TEXT        NOT NULL,
    company        TEXT        NOT NULL DEFAULT 'Unknown Company',
    source         TEXT        NOT NULL DEFAULT 'unknown',      -- Legacy: same as platform for direct crawls

    -- Human-readable details
    location       TEXT,
    description    TEXT        NOT NULL,
    salary         TEXT,
    job_type       TEXT,
    experience     TEXT,                                        -- "0-2 years", "Fresher", "2-5 years"
    seniority      TEXT,
    posted_date    TEXT,

    -- Collection metadata
    source_tier    TEXT,                                        -- rss, jsearch, direct_crawl, headless, apify

    -- Dedup fingerprint (SHA-256 hex of url+title+company)
    fingerprint    TEXT        UNIQUE,

    -- Timestamps
    scraped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// New columns added in this migration cycle — safe to re-run
const ALTER_COLUMNS = [
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS platform       TEXT DEFAULT 'unknown';`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS platform_job_id TEXT;`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_url      TEXT;`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience     TEXT;`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_tier    TEXT;`,
];

const INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_jobs_source         ON jobs(source);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_platform       ON jobs(platform);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_company        ON jobs(company);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at     ON jobs(scraped_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint    ON jobs(fingerprint);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_posted_date    ON jobs(posted_date DESC NULLS LAST);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_platform_date  ON jobs(platform, posted_date DESC);`,
    // Full-text search index on title + company
    `CREATE INDEX IF NOT EXISTS idx_jobs_fts ON jobs
     USING GIN(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(company,'')));`,
];

// ─── Runner ─────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('[migrate] Checking database connectivity…');

    const alive = await pingDb();
    if (!alive) {
        console.error('[migrate] ✗ Cannot reach PostgreSQL. Check PGHOST / PGUSER / PGPASSWORD / PGDATABASE in .env');
        console.error('[migrate]   Current PGDATABASE:', process.env.PGDATABASE ?? 'attack');
        process.exit(1);
    }
    console.log(`[migrate] ✓ Connected to "${process.env.PGDATABASE ?? 'attack'}".`);

    console.log('[migrate] Creating jobs table…');
    await query(CREATE_JOBS_TABLE);
    console.log('[migrate] ✓ jobs table ready.');

    console.log('[migrate] Running ALTER TABLE for new columns…');
    for (const alt of ALTER_COLUMNS) {
        await query(alt);
    }
    console.log(`[migrate] ✓ ${ALTER_COLUMNS.length} columns ensured.`);

    console.log('[migrate] Creating indexes…');
    for (const idx of INDEXES) {
        await query(idx);
    }
    console.log(`[migrate] ✓ ${INDEXES.length} indexes in place.`);

    await closeDb();
    console.log('[migrate] Done. Database is ready for the crawler.');
}

migrate().catch((err) => {
    console.error('[migrate] Fatal error:', err.message);
    process.exit(1);
});
