/**
 * src/utils/healthCheck.ts
 *
 * Evaluates the current metrics snapshot against configurable thresholds and
 * produces a HealthReport that describes whether the crawler is healthy,
 * degraded, or in a critical state.
 *
 * SEVERITY MODEL
 * ──────────────
 *   healthy   → everything within normal bounds, no action needed
 *   degraded  → one or more WARNING thresholds breached; worth logging prominently
 *   critical  → one or more CRITICAL thresholds breached; trigger an alert NOW
 *
 * THRESHOLD RATIONALE (documented inline for easy tuning)
 * ─────────────────────────────────────────────────────────
 * All thresholds are readable from .env first, falling back to sane defaults.
 * Change a value in .env and restart — no code edit required.
 */

import { log } from 'crawlee';
import { getMetricsSnapshot, MetricsSnapshot } from './metrics.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthSeverity = 'healthy' | 'degraded' | 'critical';

export interface HealthCheck {
    name: string;
    passed: boolean;
    severity: 'warning' | 'critical'; // only relevant when passed=false
    reason: string;
    value: number | string;
    threshold: number | string;
}

export interface HealthReport {
    severity: HealthSeverity;
    checkedAt: string;
    snapshot: MetricsSnapshot;
    checks: HealthCheck[];
    /** Human-readable summary for log output / alert body. */
    summary: string;
}

// ─── Threshold Helpers ────────────────────────────────────────────────────────

function envNum(key: string, def: number): number {
    const v = process.env[key];
    return v !== undefined && v !== '' ? Number(v) : def;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * All threshold values and their documented reasoning.
 * Override any of these via .env without code changes.
 */
const T = {
    /**
     * WARNING: success rate drops below this.
     * At 70% you are losing 3 out of 10 requests — time to investigate
     * but the crawl can limp along.
     */
    failureRateWarn: envNum('HEALTH_FAILURE_RATE_WARN_PCT', 70),

    /**
     * CRITICAL: success rate drops below this.
     * Below 40% the crawl is producing almost no data; likely a system-wide block.
     */
    failureRateCrit: envNum('HEALTH_FAILURE_RATE_CRIT_PCT', 40),

    /**
     * WARNING: no new job extracted for this many minutes.
     * Could mean selectors broke or the queue is empty (end of crawl).
     * Set high enough to avoid false alarms during rate-limit backoffs.
     */
    noProgressWarnMin: envNum('HEALTH_NO_PROGRESS_WARN_MIN', 20),

    /**
     * CRITICAL: no job extracted for this many minutes.
     * Something is fundamentally wrong — crawler may be stuck.
     */
    noProgressCritMin: envNum('HEALTH_NO_PROGRESS_CRIT_MIN', 45),

    /**
     * WARNING: memory (RSS) above this MB.
     * On a 4 GB server, 2.5 GB RSS leaves little headroom for the OS.
     */
    memoryWarnMb: envNum('HEALTH_MEMORY_WARN_MB', 2500),

    /**
     * CRITICAL: memory above this MB.
     * systemd will OOM-kill the process above available RAM.
     */
    memoryCritMb: envNum('HEALTH_MEMORY_CRIT_MB', 3500),

    /**
     * WARNING: rate-limit hits in total exceed this many.
     * A few 429s are normal; many in a short run means you are going too fast.
     */
    rateLimitWarn: envNum('HEALTH_RATE_LIMIT_WARN_COUNT', 10),

    /**
     * CRITICAL: rate-limit hits exceed this many.
     * Very likely permanent IP block territory.
     */
    rateLimitCrit: envNum('HEALTH_RATE_LIMIT_CRIT_COUNT', 30),

    /**
     * WARNING: proxy failure count exceeds this.
     * Free proxies die — 5 failures is normal. More suggests systematic issue.
     */
    proxyFailWarn: envNum('HEALTH_PROXY_FAIL_WARN_COUNT', 5),

    /**
     * CRITICAL: proxy failure count exceeds this.
     * Pool may be exhausted.
     */
    proxyFailCrit: envNum('HEALTH_PROXY_FAIL_CRIT_COUNT', 20),

    /**
     * WARNING: we have been running for more than this many minutes
     * yet haven't extracted a single job (could be config/seed URL error).
     * Only applies once we have enough uptime to be meaningful.
     */
    zeroJobsAfterMin: envNum('HEALTH_ZERO_JOBS_AFTER_MIN', 10),
};

// ─── Individual Checks ────────────────────────────────────────────────────────

function checkSuccessRate(s: MetricsSnapshot): HealthCheck {
    const name = 'success_rate';
    const total = s.requestsSucceeded + s.requestsFailed;

    // Not enough data yet — skip
    if (total < 5) {
        return {
            name, passed: true, severity: 'warning',
            reason: 'Insufficient data (< 5 requests)', value: 'N/A', threshold: 'N/A'
        };
    }

    if (s.successRatePct < T.failureRateCrit) {
        return {
            name, passed: false, severity: 'critical',
            reason: `Success rate ${s.successRatePct}% is below critical threshold ${T.failureRateCrit}%`,
            value: s.successRatePct, threshold: T.failureRateCrit,
        };
    }
    if (s.successRatePct < T.failureRateWarn) {
        return {
            name, passed: false, severity: 'warning',
            reason: `Success rate ${s.successRatePct}% is below warning threshold ${T.failureRateWarn}%`,
            value: s.successRatePct, threshold: T.failureRateWarn,
        };
    }
    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: s.successRatePct, threshold: T.failureRateWarn
    };
}

function checkNoProgress(s: MetricsSnapshot): HealthCheck {
    const name = 'no_progress';

    // Skip if crawl is brand new
    if (s.uptimeSeconds < T.noProgressWarnMin * 60) {
        return {
            name, passed: true, severity: 'warning',
            reason: 'Crawl too new to evaluate', value: 'N/A', threshold: 'N/A'
        };
    }

    const minutesSinceLast = s.lastJobExtractedAt
        ? Math.round((Date.now() - s.lastJobExtractedAt) / 60_000)
        : Math.round(s.uptimeSeconds / 60);  // Never extracted = uptime as proxy

    if (minutesSinceLast >= T.noProgressCritMin) {
        return {
            name, passed: false, severity: 'critical',
            reason: `No job extracted for ${minutesSinceLast} min (critical threshold: ${T.noProgressCritMin} min)`,
            value: minutesSinceLast, threshold: T.noProgressCritMin,
        };
    }
    if (minutesSinceLast >= T.noProgressWarnMin) {
        return {
            name, passed: false, severity: 'warning',
            reason: `No job extracted for ${minutesSinceLast} min (warning threshold: ${T.noProgressWarnMin} min)`,
            value: minutesSinceLast, threshold: T.noProgressWarnMin,
        };
    }
    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: minutesSinceLast, threshold: T.noProgressWarnMin
    };
}

function checkMemory(s: MetricsSnapshot): HealthCheck {
    const name = 'memory_usage';
    if (s.currentMemoryMb >= T.memoryCritMb) {
        return {
            name, passed: false, severity: 'critical',
            reason: `Memory ${s.currentMemoryMb} MB exceeds critical limit ${T.memoryCritMb} MB`,
            value: s.currentMemoryMb, threshold: T.memoryCritMb,
        };
    }
    if (s.currentMemoryMb >= T.memoryWarnMb) {
        return {
            name, passed: false, severity: 'warning',
            reason: `Memory ${s.currentMemoryMb} MB exceeds warning limit ${T.memoryWarnMb} MB`,
            value: s.currentMemoryMb, threshold: T.memoryWarnMb,
        };
    }
    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: s.currentMemoryMb, threshold: T.memoryWarnMb
    };
}

function checkRateLimits(s: MetricsSnapshot): HealthCheck {
    const name = 'rate_limit_hits';
    if (s.rateLimitHits >= T.rateLimitCrit) {
        return {
            name, passed: false, severity: 'critical',
            reason: `${s.rateLimitHits} rate-limit hits (critical: ${T.rateLimitCrit})`,
            value: s.rateLimitHits, threshold: T.rateLimitCrit,
        };
    }
    if (s.rateLimitHits >= T.rateLimitWarn) {
        return {
            name, passed: false, severity: 'warning',
            reason: `${s.rateLimitHits} rate-limit hits (warning: ${T.rateLimitWarn})`,
            value: s.rateLimitHits, threshold: T.rateLimitWarn,
        };
    }
    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: s.rateLimitHits, threshold: T.rateLimitWarn
    };
}

function checkProxyPool(s: MetricsSnapshot): HealthCheck {
    const name = 'proxy_failures';
    if (s.proxyFailures >= T.proxyFailCrit) {
        return {
            name, passed: false, severity: 'critical',
            reason: `${s.proxyFailures} proxy failures (critical: ${T.proxyFailCrit})`,
            value: s.proxyFailures, threshold: T.proxyFailCrit,
        };
    }
    if (s.proxyFailures >= T.proxyFailWarn) {
        return {
            name, passed: false, severity: 'warning',
            reason: `${s.proxyFailures} proxy failures (warning: ${T.proxyFailWarn})`,
            value: s.proxyFailures, threshold: T.proxyFailWarn,
        };
    }
    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: s.proxyFailures, threshold: T.proxyFailWarn
    };
}

function checkZeroJobsEarlyRun(s: MetricsSnapshot): HealthCheck {
    const name = 'zero_jobs_early';
    const uptimeMin = Math.round(s.uptimeSeconds / 60);
    if (uptimeMin >= T.zeroJobsAfterMin && s.jobsExtracted === 0) {
        return {
            name, passed: false, severity: 'warning',
            reason: `Zero jobs extracted after ${uptimeMin} min — check API keys, source endpoints, and seed URLs`,
            value: 0, threshold: T.zeroJobsAfterMin,
        };
    }

    return {
        name, passed: true, severity: 'warning', reason: 'OK',
        value: s.jobsExtracted, threshold: 0
    };
}

// ─── Main Health Check ────────────────────────────────────────────────────────

/**
 * Evaluates all health checks against current metrics and returns a HealthReport.
 * Pure function — no side effects, just reads metrics and returns status.
 */
export function getHealthStatus(): HealthReport {
    const snapshot = getMetricsSnapshot();

    const checks: HealthCheck[] = [
        checkSuccessRate(snapshot),
        checkNoProgress(snapshot),
        checkMemory(snapshot),
        checkRateLimits(snapshot),
        checkProxyPool(snapshot),
        checkZeroJobsEarlyRun(snapshot),
    ];

    const failedChecks = checks.filter((c) => !c.passed);
    const criticalChecks = failedChecks.filter((c) => c.severity === 'critical');
    const warningChecks = failedChecks.filter((c) => c.severity === 'warning');

    let severity: HealthSeverity = 'healthy';
    if (criticalChecks.length > 0) severity = 'critical';
    else if (warningChecks.length > 0) severity = 'degraded';

    const failedReasons = failedChecks.map((c) => `[${c.severity.toUpperCase()}] ${c.reason}`);
    const productivity = `${snapshot.jobsPerMinute} jobs/min, dedup ${snapshot.dedupRatioPct}% (${snapshot.jobsDeduplicated}/${snapshot.jobsExtracted}), stored ${snapshot.jobsStored}`;
    const summary = severity === 'healthy'
        ? `Crawler healthy — ${snapshot.jobsExtracted} jobs extracted, ${snapshot.successRatePct}% success rate, ${productivity}`
        : `Crawler ${severity.toUpperCase()}: ` + failedReasons.join(' | ') + ` | Productivity: ${productivity}`;

    return {
        severity,
        checkedAt: new Date().toISOString(),
        snapshot,
        checks,
        summary,
    };
}

/**
 * Logs a health report at the appropriate log level and returns the report.
 * Call this inside the health-check timer in main.ts.
 */
export function logHealthReport(): HealthReport {
    const report = getHealthStatus();

    if (report.severity === 'healthy') {
        log.info(`[Health] ✓ ${report.summary}`);
    } else if (report.severity === 'degraded') {
        log.warning(`[Health] ⚠ ${report.summary}`);
    } else {
        log.error(`[Health] ✗ ${report.summary}`);
    }

    return report;
}

/**
 * Writes the health report to ./storage/health-report.json for external inspection.
 */
export function writeHealthReport(report: HealthReport): void {
    const filePath = path.join(process.cwd(), 'storage', 'health-report.json');
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (err: any) {
        log.error(`[Health] Could not write health report: ${err.message}`);
    }
}
