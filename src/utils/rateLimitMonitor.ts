/**
 * src/utils/rateLimitMonitor.ts
 *
 * CLI-based rate-limit monitoring dashboard.
 *
 * Usage (run standalone while crawler is executing in another terminal):
 *   npx ts-node src/utils/rateLimitMonitor.ts
 *
 * Or import and call printCurrentStatus() inside the crawler for inline
 * status snapshots logged every N minutes.
 */

import { log } from 'crawlee';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAllDomainStats, DomainStats } from './domainQueue.js';
import { getViolationHistory, ViolationRecord } from './rateLimitHandler.js';
import { getRateLimitConfig } from '../config/rateLimits.js';

// ─── ANSI Colour Helpers ──────────────────────────────────────────────────────
// We use raw ANSI codes so there's zero extra dependency.

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    grey: '\x1b[90m',
};

function colourForLoad(current: number, max: number): string {
    const pct = current / max;
    if (pct >= 0.9) return C.red;
    if (pct >= 0.6) return C.yellow;
    return C.green;
}

function colourForRisk(risk: 'HIGH' | 'MEDIUM' | 'LOW'): string {
    return risk === 'HIGH' ? C.red : risk === 'MEDIUM' ? C.yellow : C.green;
}

function pad(s: string | number, len: number): string {
    return String(s).padEnd(len).substring(0, len);
}

function padL(s: string | number, len: number): string {
    return String(s).padStart(len).substring(0, len);
}

// ─── Status Table ─────────────────────────────────────────────────────────────

/**
 * Prints a formatted ASCII table of live per-domain statistics to stdout.
 * Colours indicate health:  green = healthy  yellow = approaching limit  red = at/over limit
 */
export async function printCurrentStatus(): Promise<void> {
    const stats = await getAllDomainStats();
    const violations = getViolationHistory();

    const now = new Date();
    console.log(`\n${C.bold}${C.cyan}╔══ Rate Limit Monitor — ${now.toISOString()} ══╗${C.reset}`);

    if (stats.length === 0) {
        console.log(`${C.grey}  No domains have been scraped yet.${C.reset}\n`);
        return;
    }

    const header =
        `${C.bold}` +
        `${pad('Domain', 22)} ` +
        `${pad('Req/min', 10)} ` +
        `${pad('Concurrent', 12)} ` +
        `${pad('Total', 8)} ` +
        `${pad('Blocked', 8)} ` +
        `${pad('Risk', 7)} ` +
        `${pad('Last Request', 20)}` +
        C.reset;

    console.log(header);
    console.log('─'.repeat(95));

    for (const s of stats.sort((a, b) => b.totalRequests - a.totalRequests)) {
        const config = getRateLimitConfig(s.domain);
        const rpmColour = colourForLoad(s.requestsLastMinute, s.maxRequestsPerMinute);
        const concColour = colourForLoad(s.activeConcurrent, s.maxConcurrentPerDomain);
        const riskColour = colourForRisk(config.riskLevel);
        const lastStr = s.lastRequestAt
            ? s.lastRequestAt.toTimeString().substring(0, 8)
            : '—';

        const recentViolations = violations.filter(
            (v) => v.domain === s.domain &&
                (now.getTime() - v.timestamp.getTime()) < 10 * 60_000
        ).length;

        const violFlag = recentViolations > 0 ? ` ${C.red}⚠ ${recentViolations} recent${C.reset}` : '';

        console.log(
            `${C.bold}${pad(s.domain, 22)}${C.reset} ` +
            `${rpmColour}${pad(`${s.requestsLastMinute}/${s.maxRequestsPerMinute}`, 10)}${C.reset} ` +
            `${concColour}${pad(`${s.activeConcurrent}/${s.maxConcurrentPerDomain}`, 12)}${C.reset} ` +
            `${pad(s.totalRequests, 8)} ` +
            `${pad(s.totalBlocked, 8)} ` +
            `${riskColour}${pad(config.riskLevel, 7)}${C.reset} ` +
            `${C.grey}${lastStr}${C.reset}` +
            violFlag
        );
    }

    console.log('─'.repeat(95));
}

// ─── Violation History ────────────────────────────────────────────────────────

/** Prints the 20 most recent rate-limit violation events. */
export function printViolationHistory(): void {
    const history = getViolationHistory().slice(-20).reverse();

    console.log(`\n${C.bold}${C.cyan}╔══ Recent Rate-Limit Violations (last 20) ══╗${C.reset}`);

    if (history.length === 0) {
        console.log(`${C.green}  No violations recorded. 🎉${C.reset}\n`);
        return;
    }

    for (const v of history) {
        const ago = Math.round((Date.now() - v.timestamp.getTime()) / 1000);
        const waitSec = (v.backoffMs / 1000).toFixed(0);
        const status = v.statusCode ? `HTTP ${v.statusCode}` : 'soft-block';
        console.log(
            `  ${C.grey}${v.timestamp.toTimeString().substring(0, 8)}${C.reset} ` +
            `${C.bold}${v.domain}${C.reset} — ${v.reason} ` +
            `${C.yellow}(${status})${C.reset} ` +
            `backoff ${C.red}${waitSec}s${C.reset} ` +
            `attempt #${v.attempt} ` +
            `${C.grey}${ago}s ago${C.reset}`
        );
    }
    console.log();
}

// ─── Recommendations ─────────────────────────────────────────────────────────

/** Analyses current stats and prints actionable tuning advice. */
export async function printRecommendations(): Promise<void> {
    const stats = await getAllDomainStats();
    const violations = getViolationHistory();
    const now = Date.now();

    console.log(`\n${C.bold}${C.cyan}╔══ Recommendations ══╗${C.reset}`);

    let anyRec = false;

    for (const s of stats) {
        const config = getRateLimitConfig(s.domain);
        const recentV = violations.filter(
            (v) => v.domain === s.domain && (now - v.timestamp.getTime()) < 30 * 60_000
        ).length;

        // Recommend slowing down if there have been violations recently
        if (recentV >= 3) {
            console.log(
                `  ${C.red}⬇  ${s.domain}${C.reset}: ${recentV} violations in 30 min. ` +
                `Consider increasing BASE_DELAY_MS from config (currently ${config.minDelayMs}ms).`
            );
            anyRec = true;
        }

        // Recommend speeding up if there are zero violations and utilisation < 40%
        const rpmPct = s.requestsLastMinute / s.maxRequestsPerMinute;
        if (recentV === 0 && rpmPct < 0.4 && s.totalRequests > 20) {
            console.log(
                `  ${C.green}⬆  ${s.domain}${C.reset}: Utilisation at ${Math.round(rpmPct * 100)}%, ` +
                `zero recent violations. You could safely reduce minDelayMs.`
            );
            anyRec = true;
        }

        // Warn on HIGH-risk domains if request count is growing fast
        if (config.riskLevel === 'HIGH' && s.requestsLastMinute >= config.maxRequestsPerMinute * 0.8) {
            console.log(
                `  ${C.yellow}⚠  ${s.domain}${C.reset}: HIGH-risk domain approaching rate limit. ` +
                `Pause manually if 429s start appearing.`
            );
            anyRec = true;
        }
    }

    if (!anyRec) {
        console.log(`  ${C.green}All domains within healthy thresholds. ✓${C.reset}`);
    }
    console.log();
}

// ─── File Export ──────────────────────────────────────────────────────────────

/**
 * Writes a JSON report (stats + violations) to disk.
 * @param outputPath Defaults to ./storage/rate-limit-report.json
 */
export async function exportReport(outputPath?: string): Promise<void> {
    const filePath = outputPath ?? path.join(process.cwd(), 'storage', 'rate-limit-report.json');

    const stats = await getAllDomainStats();
    const violations = getViolationHistory();

    const report = {
        generatedAt: new Date().toISOString(),
        domainStats: stats,
        violationHistory: violations,
    };

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
        log.info(`[Monitor] Rate-limit report saved to: ${filePath}`);
    } catch (err: any) {
        log.error(`[Monitor] Failed to write report: ${err.message}`);
    }
}

// ─── Standalone Entry Point ───────────────────────────────────────────────────

/**
 * If this file is run directly (not imported), print a one-shot dashboard.
 * Usage: npx ts-node src/utils/rateLimitMonitor.ts
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    (async () => {
        await printCurrentStatus();
        printViolationHistory();
        await printRecommendations();
    })();
}
