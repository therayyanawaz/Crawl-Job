/**
 * src/utils/dedup.ts
 *
 * Public deduplication façade used by routes.ts.
 *
 * Wraps fingerprint generation + store lookup into two simple functions:
 *   isDuplicateJob()   → boolean check + reason
 *   markJobAsStored()  → record in store after successful pushData()
 *
 * Also owns the per-run statistics that feed into the monitoring report.
 */

import { log } from 'crawlee';
import { getJobFingerprints, FingerprintableJob } from './fingerprint';
import { checkDuplicate, markJobAsSeen, getStoreSize } from './dedupStore';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DuplicateReason = 'url' | 'content' | 'none';

export interface DedupResult {
    isDuplicate: boolean;
    reason: DuplicateReason;
}

// In-process stats for the current crawl run
interface RunStats {
    totalProcessed: number;
    totalSkipped: number;
    skippedByUrl: number;
    skippedByContent: number;
    totalStored: number;
}

const stats: RunStats = {
    totalProcessed: 0,
    totalSkipped: 0,
    skippedByUrl: 0,
    skippedByContent: 0,
    totalStored: 0,
};

// ─── Config ───────────────────────────────────────────────────────────────────

const DEDUP_ENABLED = process.env.DEDUP_ENABLED !== 'false';

/** Log a message when a duplicate is found (disable for high-volume runs). */
const DEDUP_LOG_SKIPPED = process.env.DEDUP_LOG_SKIPPED !== 'false';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks whether a given job record is a duplicate.
 *
 * Always increments `totalProcessed`.
 * If a duplicate is found, increments the appropriate skip counter.
 *
 * @param job  Any object satisfying FingerprintableJob (subset of your JobRecord).
 * @returns    DedupResult — { isDuplicate, reason }
 */
export function isDuplicateJob(job: FingerprintableJob): DedupResult {
    stats.totalProcessed++;

    if (!DEDUP_ENABLED) {
        return { isDuplicate: false, reason: 'none' };
    }

    const fp = getJobFingerprints(job);
    const reason = checkDuplicate(fp);    // 'url' | 'content' | 'none'

    if (reason !== 'none') {
        stats.totalSkipped++;
        if (reason === 'url') stats.skippedByUrl++;
        if (reason === 'content') stats.skippedByContent++;

        if (DEDUP_LOG_SKIPPED) {
            log.debug(
                `[Dedup] SKIP — ${reason.toUpperCase()} duplicate: ` +
                `"${fp.normalizedTitle}" @ "${fp.normalizedCompany}" (${job.url})`
            );
        }

        return { isDuplicate: true, reason };
    }

    return { isDuplicate: false, reason: 'none' };
}

/**
 * Marks a job as stored in the persistent dedup store.
 * MUST be called only after pushData() has succeeded — never speculatively.
 *
 * @param job  Same object passed to isDuplicateJob().
 */
export function markJobAsStored(job: FingerprintableJob): void {
    if (!DEDUP_ENABLED) return;

    const fp = getJobFingerprints(job);
    markJobAsSeen(fp);
    stats.totalStored++;
}

/**
 * Returns a snapshot of the current run's deduplication statistics.
 * Used by the monitoring and the post-run report.
 */
export function getDedupStats(): Readonly<RunStats> & { storeSize: number } {
    return {
        ...stats,
        storeSize: getStoreSize(),
    };
}

/**
 * Logs a formatted dedup summary — call at the end of a crawl run.
 */
export function logDedupSummary(): void {
    const s = getDedupStats();
    const dupRate = s.totalProcessed > 0
        ? Math.round((s.totalSkipped / s.totalProcessed) * 100)
        : 0;

    log.info(
        `[Dedup] Run summary — ` +
        `Processed: ${s.totalProcessed} | ` +
        `Stored: ${s.totalStored} | ` +
        `Skipped: ${s.totalSkipped} (${dupRate}%) ` +
        `[url:${s.skippedByUrl} content:${s.skippedByContent}] | ` +
        `Total in store: ${s.storeSize}`
    );
}
