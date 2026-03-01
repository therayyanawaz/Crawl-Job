/**
 * src/utils/jobStore.ts
 *
 * Persists a validated JobRecord to the PostgreSQL `crawl_job` database.
 *
 * Schema aligned with STRATEGY.md § 7 + § 8.
 *
 * Design
 * ──────
 * • Uses INSERT … ON CONFLICT (fingerprint) DO NOTHING so duplicate jobs
 *   (same URL + title + company) are silently skipped at the DB level.
 * • All DB failures are caught and logged — they never throw.
 * • The fingerprint is a SHA-256 hex of "<url>||<title>||<company>".
 */

import { createHash } from 'crypto';
import { query } from './db.js';
import { log } from 'crawlee';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Superset of fields that may arrive from routes.ts (headless) or
 * orchestrator.ts (HTTP/API sources). All optional fields are nullable in DB.
 */
export interface StorableJob {
    url: string;
    title: string;
    company: string;
    source?: string;
    location?: string;
    description: string;
    salary?: string;
    jobType?: string;
    experience?: string;
    seniority?: string;
    postedDate?: string;
    scrapedAt: string;
    // New fields from STRATEGY.md
    platform?: string;          // e.g. 'indeed', 'linkedin', 'naukri'
    platformJobId?: string;     // Platform's own ID
    applyUrl?: string;          // Direct application link
    sourceTier?: string;        // rss, jsearch, direct_crawl, headless, apify
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFingerprint(job: StorableJob): string {
    return createHash('sha256')
        .update(`${job.url}||${job.title}||${job.company}`)
        .digest('hex');
}

// ─── Insert ─────────────────────────────────────────────────────────────────

const INSERT_SQL = `
INSERT INTO jobs
    (url, title, company, source, location, description,
     salary, job_type, experience, seniority, posted_date,
     platform, platform_job_id, apply_url, source_tier,
     fingerprint, scraped_at)
VALUES
    ($1,  $2,    $3,      $4,     $5,       $6,
     $7,    $8,       $9,         $10,      $11,
     $12,   $13,            $14,       $15,
     $16,         $17)
ON CONFLICT (fingerprint) DO NOTHING
RETURNING id;
`;

/**
 * Write a single validated job to the database.
 *
 * @returns The new row's `id` if inserted, or `null` if skipped (duplicate).
 */
export async function saveJobToDb(job: StorableJob): Promise<number | null> {
    const fingerprint = makeFingerprint(job);

    try {
        const result = await query<{ id: number }>(INSERT_SQL, [
            job.url,
            job.title,
            job.company,
            job.source ?? job.platform ?? 'unknown',
            job.location ?? null,
            job.description,
            job.salary ?? null,
            job.jobType ?? null,
            job.experience ?? null,
            job.seniority ?? null,
            job.postedDate ?? null,
            job.platform ?? job.source ?? 'unknown',
            job.platformJobId ?? null,
            job.applyUrl ?? null,
            job.sourceTier ?? null,
            fingerprint,
            job.scrapedAt,
        ]);

        if (result.rowCount && result.rowCount > 0) {
            const id = result.rows[0]?.id;
            log.debug(`[DB] Inserted job id=${id}: "${job.title}" @ "${job.company}" [${job.platform ?? job.source}]`);
            return id ?? null;
        }

        // ON CONFLICT DO NOTHING → rowCount === 0 → duplicate
        log.debug(`[DB] Skipped duplicate: "${job.title}" @ "${job.company}"`);
        return null;

    } catch (err: any) {
        log.error(`[DB] Insert failed for "${job.title}": ${err.message}`);
        return null;
    }
}

/**
 * Returns the total number of jobs currently stored in the DB.
 */
export async function countJobsInDb(): Promise<number> {
    try {
        const { rows } = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM jobs');
        return Number(rows[0]?.count ?? 0);
    } catch {
        return -1;
    }
}
