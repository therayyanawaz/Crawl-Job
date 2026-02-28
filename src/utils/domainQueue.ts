/**
 * src/utils/domainQueue.ts
 *
 * Per-domain request tracking and concurrency gate.
 *
 * Why not use Crawlee's built-in maxRequestsPerMinute?
 * ─────────────────────────────────────────────────────
 * Crawlee's global maxRequestsPerMinute applies to the WHOLE crawler.
 * We need per-DOMAIN limits so that LinkedIn is throttled to 4 req/min
 * while Internshala runs at 15 req/min simultaneously — the global limit
 * would bottleneck the faster, safer domains to the slowest one.
 *
 * Design: sliding 1-minute window per domain.
 * We store timestamps of the last N requests; before allowing a new one
 * we drop timestamps older than 60 s and compare the count to the
 * domain's maxRequestsPerMinute.  No external dependencies — pure RAM.
 */

import { log } from 'crawlee';
import { getRateLimitConfig } from '../config/rateLimits';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DomainStats {
    domain: string;
    requestsLastMinute: number;
    maxRequestsPerMinute: number;
    activeConcurrent: number;
    maxConcurrentPerDomain: number;
    lastRequestAt: Date | null;
    totalRequests: number;
    totalBlocked: number;     // Times canProceed returned false
}

// ─── Internal State ───────────────────────────────────────────────────────────

/** Sliding-window timestamps: domain → array of epoch-ms timestamps */
const requestTimestamps: Map<string, number[]> = new Map();

/** Count of currently-open page contexts per domain (semaphore). */
const activeConcurrent: Map<string, number> = new Map();

/** Last request timestamp per domain (for reporting). */
const lastRequestAt: Map<string, number> = new Map();

/** Lifetime totals per domain. */
const totalRequests: Map<string, number> = new Map();
const totalBlocked: Map<string, number> = new Map();

/** Cleanup interval handle (stored so cleanup() can cancel it). */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

// ─── Sliding Window Helper ────────────────────────────────────────────────────

/**
 * Returns request timestamps for `domain` within the last 60 seconds,
 * and prunes stale entries in-place for memory efficiency.
 */
function getLiveTimestamps(domain: string): number[] {
    const now = Date.now();
    const windowStart = now - 60_000;
    const raw = requestTimestamps.get(domain) ?? [];
    const live = raw.filter((ts) => ts > windowStart);
    requestTimestamps.set(domain, live);
    return live;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the domain queue manager.
 * Call once at startup — kicks off the periodic stale-data cleanup.
 *
 * @param cleanupIntervalMs  How often to clean old timestamps (default 5 min).
 */
export function init(cleanupIntervalMs = 5 * 60 * 1000): void {
    if (cleanupIntervalId !== null) return; // Already initialised

    // Periodic sweep: drop domains that haven't had a request in >10 minutes
    // to prevent unbounded Map growth during multi-hour crawls.
    cleanupIntervalId = setInterval(() => {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [domain, ts] of lastRequestAt) {
            if (ts < cutoff) {
                requestTimestamps.delete(domain);
                activeConcurrent.delete(domain);
                // Keep totalRequests / totalBlocked for reporting — they're small
                lastRequestAt.delete(domain);
                log.debug(`[DomainQueue] Pruned stale tracking data for: ${domain}`);
            }
        }
    }, cleanupIntervalMs);

    log.info('[DomainQueue] Initialised.');
}

/**
 * Determines whether a new request to `domain` is allowed right now.
 *
 * Returns false (and increments totalBlocked) if:
 *  a) The sliding-window count ≥ maxRequestsPerMinute, OR
 *  b) Active concurrent requests ≥ maxConcurrentPerDomain.
 *
 * This is NOT a blocking queue — the caller is responsible for waiting
 * and retrying (handled by the preNavigationHook in main.ts).
 */
export async function canProceed(domain: string): Promise<boolean> {
    const config = getRateLimitConfig(domain);
    const live = getLiveTimestamps(domain);
    const active = activeConcurrent.get(domain) ?? 0;

    const rpmOk = live.length < config.maxRequestsPerMinute;
    const concOk = active < config.maxConcurrentPerDomain;

    if (!rpmOk || !concOk) {
        totalBlocked.set(domain, (totalBlocked.get(domain) ?? 0) + 1);

        if (!rpmOk) {
            log.debug(
                `[DomainQueue] Rate limit reached for ${domain}: ` +
                `${live.length}/${config.maxRequestsPerMinute} req/min.`
            );
        }
        if (!concOk) {
            log.debug(
                `[DomainQueue] Concurrency limit reached for ${domain}: ` +
                `${active}/${config.maxConcurrentPerDomain} concurrent.`
            );
        }
        return false;
    }

    return true;
}

/**
 * Records that a request to `domain` has STARTED.
 * Must be paired with a later call to releaseRequest() when the page closes.
 */
export async function recordRequest(domain: string): Promise<void> {
    const now = Date.now();

    // Sliding window
    const live = getLiveTimestamps(domain);
    live.push(now);
    requestTimestamps.set(domain, live);

    // Concurrency semaphore
    activeConcurrent.set(domain, (activeConcurrent.get(domain) ?? 0) + 1);

    // Stats
    lastRequestAt.set(domain, now);
    totalRequests.set(domain, (totalRequests.get(domain) ?? 0) + 1);
}

/**
 * Records that the request to `domain` has COMPLETED (page closed / error).
 * Must be called in a finally block in the pre/post navigation hooks.
 */
export async function releaseRequest(domain: string): Promise<void> {
    const cur = activeConcurrent.get(domain) ?? 0;
    activeConcurrent.set(domain, Math.max(0, cur - 1));
}

/**
 * Returns a snapshot of current stats for `domain`.
 * Used by the monitoring dashboard (rateLimitMonitor.ts).
 */
export async function getDomainStats(domain: string): Promise<DomainStats> {
    const config = getRateLimitConfig(domain);
    const live = getLiveTimestamps(domain);
    const ts = lastRequestAt.get(domain);

    return {
        domain,
        requestsLastMinute: live.length,
        maxRequestsPerMinute: config.maxRequestsPerMinute,
        activeConcurrent: activeConcurrent.get(domain) ?? 0,
        maxConcurrentPerDomain: config.maxConcurrentPerDomain,
        lastRequestAt: ts ? new Date(ts) : null,
        totalRequests: totalRequests.get(domain) ?? 0,
        totalBlocked: totalBlocked.get(domain) ?? 0,
    };
}

/**
 * Returns stats for every domain that has been seen at least once.
 */
export async function getAllDomainStats(): Promise<DomainStats[]> {
    const all = new Set([
        ...requestTimestamps.keys(),
        ...totalRequests.keys(),
    ]);
    const results: DomainStats[] = [];
    for (const d of all) results.push(await getDomainStats(d));
    return results;
}

/**
 * Resets all counters for all domains.
 * Useful during testing or when you want a clean slate without restarting.
 */
export async function resetCounters(): Promise<void> {
    requestTimestamps.clear();
    activeConcurrent.clear();
    lastRequestAt.clear();
    totalRequests.clear();
    totalBlocked.clear();
    log.info('[DomainQueue] All counters reset.');
}

/**
 * Stops the cleanup interval.
 * Call this in a finally block around crawler.run() to avoid dangling timers.
 */
export async function cleanup(): Promise<void> {
    if (cleanupIntervalId !== null) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
    log.info('[DomainQueue] Cleanup complete.');
}
