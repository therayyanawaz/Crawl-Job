/**
 * src/utils/dedup.ts
 *
 * Public deduplication façade used by routes.ts.
 *
 * Wraps fingerprint generation + store lookup into two simple functions:
 *   isDuplicateJob()   → boolean check + reason
 *   markJobAsStored()  → record in store after successful pushData()
 *
 * Also owns the per‑run statistics that feed into the monitoring report.
 */

import { log } from 'crawlee';
import { getJobFingerprints, FingerprintableJob } from './fingerprint.js';
import { checkDuplicate, markJobAsSeen, getStoreSize } from './dedupStore.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DuplicateReason = 'url' | 'content' | 'none';

export interface DedupResult {
    isDuplicate: boolean;
    reason: DuplicateReason;
}

// In‑process stats for the current crawl run
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

/** Enable/disable deduplication globally (default: enabled). */
const DEDUP_ENABLED = process.env.DEDUP_ENABLED !== 'false';
/** Log a message when a duplicate is found (default: enabled). */
const DEDUP_LOG_SKIPPED = process.env.DEDUP_LOG_SKIPPED !== 'false';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks whether a given job record is a duplicate.
 *
 * This function is **async** because the underlying dedup store (Redis)
 * performs network I/O.
 *
 * Always increments `totalProcessed`. If a duplicate is found, the appropriate
 * skip counter is incremented and an optional debug message is logged.
 *
 * @param job  Any object satisfying `FingerprintableJob`.
 * @returns    Promise resolving to `DedupResult` – `{ isDuplicate, reason }`.
 */
export async function isDuplicateJob(job: FingerprintableJob): Promise<DedupResult> {
    stats.totalProcessed++;

    if (!DEDUP_ENABLED) {
        return { isDuplicate: false, reason: 'none' };
    }

    const fp = getJobFingerprints(job);
    const reason = await checkDuplicate(fp); // ← async Redis lookup

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
 *
 * This function is **async** to await the Redis write operation.
 *
 * Must be called *only* after `pushData()` (or equivalent) has succeeded.
 *
 * @param job  Same object passed to `isDuplicateJob()`.
 */
export async function markJobAsStored(job: FingerprintableJob): Promise<void> {
    if (!DEDUP_ENABLED) return;

    const fp = getJobFingerprints(job);
    await markJobAsSeen(fp); // ← async Redis write
    stats.totalStored++;
}

/**
 * Returns a snapshot of the current run's deduplication statistics.
 *
 * The store size requires an asynchronous call to Redis.
 *
 * @returns Promise resolving to the statistics object plus `storeSize`.
 */
export async function getDedupStats(): Promise<Readonly<RunStats> & { storeSize: number }> {
    const storeSize = await getStoreSize(); // async Redis count
    return {
        ...stats,
        storeSize,
    };
}

/**
 * Logs a formatted deduplication summary.
 *
 * This function is **async** because it awaits `getDedupStats()`.
 * Call it at the end of a crawl run to emit a concise report.
 */
export async function logDedupSummary(): Promise<void> {
    const s = await getDedupStats();
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
