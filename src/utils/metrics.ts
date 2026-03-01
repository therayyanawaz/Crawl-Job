/**
 * src/utils/metrics.ts
 *
 * Lightweight, zero-dependency metrics accumulator for the crawl process.
 *
 * DESIGN CHOICES
 * ──────────────
 * • Pure in-memory — every counter is a plain number/Map held in module scope.
 *   No Redis, no Prometheus, no extra processes. Works on any headless box.
 *
 * • Sliding RPM window — we keep a rolling array of request timestamps from the
 *   last 60 seconds (same technique as domainQueue.ts) to compute real RPM
 *   without ever storing unbounded history.
 *
 * • Periodic JSON flush to ./storage/metrics-snapshot.json — a crash loses at
 *   most FLUSH_INTERVAL_MS (default 2 min) of metric history. The file is used
 *   by external one-liner checks (`cat storage/metrics-snapshot.json`).
 *
 * • All public functions are synchronous — calling them inside Crawlee hooks
 *   adds zero async overhead to the hot path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from 'crawlee';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
    /** ISO timestamp of when this snapshot was taken. */
    snapshotAt: string;

    /** Total requests that reached the requestHandler (any outcome). */
    requestsStarted: number;

    /** Requests that completed without an unhandled exception. */
    requestsSucceeded: number;

    /** Requests that hit failedRequestHandler (all retries exhausted). */
    requestsFailed: number;

    /** Success rate 0–100. */
    successRatePct: number;

    /** Total validated job records extracted and evaluated by dedup. */
    jobsExtracted: number;

    /** Job records skipped by dedup. */
    jobsDeduplicated: number;

    /** Job records successfully persisted to DB. */
    jobsStored: number;

    /** Job records that failed to persist to DB. */
    jobsPersistenceFailed: number;

    /** Extraction throughput over total uptime. */
    jobsPerMinute: number;

    /** Percent of extracted jobs skipped by dedup (0–100). */
    dedupRatioPct: number;

    /** HTTP 429 or 403 events recorded across all domains. */
    rateLimitHits: number;

    /** Proxy validation/connection failures. */
    proxyFailures: number;

    /** Requests per minute over the last 60 seconds (sliding window). */
    requestsPerMinute: number;

    /** Average response time in ms over the last 100 requests. */
    avgResponseTimeMs: number;

    /** Peak memory usage recorded (RSS in MB). */
    peakMemoryMb: number;

    /** Current process RSS memory in MB. */
    currentMemoryMb: number;

    /** Unix epoch when the crawl started. */
    crawlStartedAt: number;

    /** Elapsed time in seconds since start. */
    uptimeSeconds: number;

    /** Last time a job was successfully extracted (Unix epoch ms), or 0. */
    lastJobExtractedAt: number;
}

// ─── Internal State ───────────────────────────────────────────────────────────

let crawlStartedAt = 0;
let requestsStarted = 0;
let requestsSucceeded = 0;
let requestsFailed = 0;
let jobsExtracted = 0;
let jobsDeduplicated = 0;
let jobsStored = 0;
let jobsPersistenceFailed = 0;
let rateLimitHits = 0;
let proxyFailures = 0;
let peakMemoryMb = 0;
let lastJobAt = 0;

/** Rolling timestamps (epoch ms) for sliding-window RPM. */
const rpmWindow: number[] = [];

/** Ring buffer of the last 100 response times (ms) for average calculation. */
const responseTimes: number[] = [];
const RT_RING_SIZE = 100;

let flushTimerId: ReturnType<typeof setInterval> | null = null;

const METRICS_PATH = path.join(process.cwd(), 'storage', 'metrics-snapshot.json');
const FLUSH_INTERVAL_MS = Number(process.env.METRICS_FLUSH_INTERVAL_MS ?? 120_000); // 2 min

// ─── Init / Cleanup ───────────────────────────────────────────────────────────

/** Call once at the very start of runCrawler(). */
export function initMetrics(): void {
    crawlStartedAt = Date.now();
    requestsStarted = 0;
    requestsSucceeded = 0;
    requestsFailed = 0;
    jobsExtracted = 0;
    jobsDeduplicated = 0;
    jobsStored = 0;
    jobsPersistenceFailed = 0;
    rateLimitHits = 0;
    proxyFailures = 0;
    peakMemoryMb = 0;
    lastJobAt = 0;
    rpmWindow.length = 0;
    responseTimes.length = 0;

    if (flushTimerId !== null) clearInterval(flushTimerId);
    flushTimerId = setInterval(() => flushMetrics(), FLUSH_INTERVAL_MS);

    log.info('[Metrics] Initialised. Flush interval: ' + (FLUSH_INTERVAL_MS / 1000) + 's.');
}

/** Flush to disk and stop flush timer. Call in finally block. */
export function closeMetrics(): void {
    if (flushTimerId !== null) {
        clearInterval(flushTimerId);
        flushTimerId = null;
    }
    flushMetrics();
    log.info('[Metrics] Final snapshot written.');
}

// ─── Record Helpers ───────────────────────────────────────────────────────────

/** Call at the START of every requestHandler invocation. */
export function recordRequestStarted(): void {
    requestsStarted++;
    rpmWindow.push(Date.now());
    // Prune entries older than 60 s from the RPM window
    const cutoff = Date.now() - 60_000;
    while (rpmWindow.length > 0 && rpmWindow[0] < cutoff) rpmWindow.shift();

    // Track peak memory
    const rss = process.memoryUsage().rss / 1_048_576; // bytes → MB
    if (rss > peakMemoryMb) peakMemoryMb = rss;
}

/** Call when a request completes successfully (no exception). */
export function recordRequestSuccess(responseTimeMs?: number): void {
    requestsSucceeded++;

    if (
        responseTimeMs === undefined ||
        !Number.isFinite(responseTimeMs) ||
        responseTimeMs < 0
    ) {
        return;
    }

    // Ring-buffer insert
    if (responseTimes.length >= RT_RING_SIZE) responseTimes.shift();
    responseTimes.push(responseTimeMs);
}

/** Call inside failedRequestHandler. */
export function recordRequestFailed(): void {
    requestsFailed++;
}

/** Call after every successful pushData() in routes.ts. */
export function recordJobExtracted(): void {
    jobsExtracted++;
    lastJobAt = Date.now();
}

/** Call when dedup skips a job. */
export function recordJobDeduplicated(): void {
    jobsDeduplicated++;
}

/** Call after a successful DB insert for a job. */
export function recordJobStored(): void {
    jobsStored++;
}

/** Call when a job fails DB persistence. */
export function recordJobPersistenceFailed(): void {
    jobsPersistenceFailed++;
}

/** Call when a 429 / 403 rate-limit event is detected. */
export function recordRateLimitHit(): void {
    rateLimitHits++;
}

/** Call when a proxy validation/connection failure occurs. */
export function recordProxyFailure(): void {
    proxyFailures++;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/** Returns a point-in-time snapshot of all metrics. Pure read, no side effects. */
export function getMetricsSnapshot(): MetricsSnapshot {
    const now = Date.now();

    // Prune the RPM window before computing
    const cutoff = now - 60_000;
    while (rpmWindow.length > 0 && rpmWindow[0] < cutoff) rpmWindow.shift();

    const total = requestsSucceeded + requestsFailed;
    const successRatePct = total > 0
        ? Math.round((requestsSucceeded / total) * 100)
        : 100;

    const avgResponseTimeMs = responseTimes.length > 0
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : 0;

    const currentMemoryMb = Math.round(process.memoryUsage().rss / 1_048_576);
    const uptimeMinutes = Math.max(1 / 60, (now - crawlStartedAt) / 60_000);
    const dedupRatioPct = jobsExtracted > 0
        ? Math.round((jobsDeduplicated / jobsExtracted) * 1000) / 10
        : 0;
    const jobsPerMinute = Math.round((jobsExtracted / uptimeMinutes) * 10) / 10;

    return {
        snapshotAt: new Date().toISOString(),
        requestsStarted,
        requestsSucceeded,
        requestsFailed,
        successRatePct,
        jobsExtracted,
        jobsDeduplicated,
        jobsStored,
        jobsPersistenceFailed,
        jobsPerMinute,
        dedupRatioPct,
        rateLimitHits,
        proxyFailures,
        requestsPerMinute: rpmWindow.length,  // count within rolling 60s = RPM
        avgResponseTimeMs,
        peakMemoryMb: Math.round(peakMemoryMb),
        currentMemoryMb,
        crawlStartedAt,
        uptimeSeconds: Math.round((now - crawlStartedAt) / 1000),
        lastJobExtractedAt: lastJobAt,
    };
}

// ─── Flush to Disk ────────────────────────────────────────────────────────────

function flushMetrics(): void {
    const snap = getMetricsSnapshot();
    try {
        fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
        fs.writeFileSync(METRICS_PATH, JSON.stringify(snap, null, 2), 'utf-8');
    } catch (err: any) {
        log.error(`[Metrics] Flush failed: ${err.message}`);
    }
}

// ─── Formatted Log Line ───────────────────────────────────────────────────────

/**
 * Emits a compact one-line metrics summary to the Crawlee log.
 * Called periodically by the health-check timer in main.ts.
 */
export function logMetricsSummary(): void {
    const s = getMetricsSnapshot();
    const minsAgo = s.lastJobExtractedAt
        ? Math.round((Date.now() - s.lastJobExtractedAt) / 60_000)
        : null;

    log.info(
        `[Metrics] ✓${s.requestsSucceeded} ✗${s.requestsFailed} ` +
        `(${s.successRatePct}% ok) | ` +
        `jobs:${s.jobsExtracted} dedup:${s.jobsDeduplicated} stored:${s.jobsStored} persistFail:${s.jobsPersistenceFailed} | ` +
        `jobs/min:${s.jobsPerMinute} dedupRatio:${s.dedupRatioPct}% | ` +
        `rpm:${s.requestsPerMinute} avgRt:${s.avgResponseTimeMs}ms | ` +
        `429s:${s.rateLimitHits} proxyFail:${s.proxyFailures} | ` +
        `mem:${s.currentMemoryMb}MB ` +
        (minsAgo !== null ? `| lastJob:${minsAgo}m ago` : '| lastJob:never')
    );
}
