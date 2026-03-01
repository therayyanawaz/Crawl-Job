/**
 * src/utils/rateLimitHandler.ts
 *
 * Detects rate-limit responses and soft block pages, then applies
 * domain-specific exponential backoff before the request is retried
 * by Crawlee's built-in retry machinery.
 *
 * Backoff formula:
 *   delay = min(baseBackoffMs × mult^attempt + jitter, maxBackoffMs)
 *
 * Why exponential and not fixed?
 * A fixed 60-second pause after a 429 on LinkedIn is exactly what a bot
 * does. Exponential backoff with jitter looks more like a browser that
 * got interrupted and later came back — far less suspicious.
 */

import type { Page, Response } from 'playwright';
import { log } from 'crawlee';
import { getRateLimitConfig } from '../config/rateLimits.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ViolationRecord {
    domain: string;
    reason: string;
    statusCode: number | null;
    timestamp: Date;
    backoffMs: number;
    attempt: number;
}

// ─── Violation History ────────────────────────────────────────────────────────

/** In-memory ring buffer of the last 200 violations across all domains. */
const VIOLATION_HISTORY: ViolationRecord[] = [];
const MAX_HISTORY = 200;

/** Per-domain attempt counter — resets when a domain succeeds. */
const domainAttempts: Map<string, number> = new Map();

// ─── Block-Page Fingerprints ──────────────────────────────────────────────────

/**
 * Text patterns found in block/CAPTCHA pages on major job boards.
 * Matching any of these in the page title or body indicates a soft block.
 *
 * Kept as lowercase strings — compare against page.title().toLowerCase().
 */
const BLOCK_PAGE_PATTERNS: string[] = [
    'unusual traffic',           // Google / Glassdoor challenge
    'access denied',             // Generic WAF
    'blocked',                   // Generic
    'captcha',                   // CAPTCHA challenge
    'suspicious activity',       // LinkedIn security check
    'let us know you\'re human', // Cloudflare Turnstile
    'are you a robot',           // Indeed bot challenge
    'too many requests',         // 429 body text
    'abuse',                     // Naukri abuse page
    'rate limit exceeded',       // API style message
    'security check',            // Glassdoor
];

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true if the HTTP response status code is a known hard rate-limit
 * or block signal (429, 403, 503 are all returned by bot-detection systems).
 *
 * Note: 503 with "Service Unavailable" from Cloudflare is almost always a
 * JavaScript challenge being served, not a real server error.
 */
export function detectRateLimitByStatus(response: Response): boolean {
    const status = response.status();
    return status === 429 || status === 403 || status === 503;
}

/**
 * Returns true if the loaded page *content* looks like a block/CAPTCHA page,
 * even if the HTTP status was 200 (which is common with Cloudflare and Datadome).
 *
 * We check both the page title and the first 3000 characters of body text
 * to avoid reading the entire DOM (memory efficiency).
 */
export async function isBlocked(page: Page): Promise<boolean> {
    try {
        const title = (await page.title()).toLowerCase();

        // Fast path: check title first (cheapest operation)
        for (const pattern of BLOCK_PAGE_PATTERNS) {
            if (title.includes(pattern)) return true;
        }

        // Slower path: check visible body text
        const bodyText = await page.evaluate(() => {
            const el = document.body;
            if (!el) return '';
            return (el.innerText ?? '').substring(0, 3000).toLowerCase();
        });

        for (const pattern of BLOCK_PAGE_PATTERNS) {
            if (bodyText.includes(pattern)) return true;
        }

        return false;
    } catch {
        // Page may have closed mid-check — treat as non-blocked
        return false;
    }
}

// ─── Backoff Calculation ──────────────────────────────────────────────────────

/**
 * Calculates the backoff delay in milliseconds for a given domain and attempt.
 *
 * @param attempt  1-indexed attempt number (1 = first backoff after first block).
 * @param domain   Domain key (used to look up domain-specific multiplier).
 */
export function getBackoffDelay(attempt: number, domain: string): number {
    const config = getRateLimitConfig(domain);

    const envMultiplier = process.env.RATE_LIMIT_BACKOFF_MULTIPLIER
        ? Number(process.env.RATE_LIMIT_BACKOFF_MULTIPLIER)
        : config.backoffMultiplier;

    const baseMs = 30_000; // 30 seconds base — always start polite
    const jitter = Math.random() * 10_000; // Up to 10s jitter

    const exponential = baseMs * Math.pow(envMultiplier, attempt - 1);
    const capped = Math.min(exponential + jitter, config.maxBackoffMs);

    return Math.round(capped);
}

// ─── Violation Logger ─────────────────────────────────────────────────────────

/**
 * Logs and records a rate-limit violation event.
 * Called whenever detectRateLimitByStatus or isBlocked returns true.
 */
export function logViolation(
    domain: string,
    reason: string,
    statusCode: number | null,
    backoffMs: number,
    attempt: number
): void {
    const record: ViolationRecord = {
        domain, reason, statusCode,
        timestamp: new Date(),
        backoffMs, attempt,
    };

    VIOLATION_HISTORY.push(record);
    if (VIOLATION_HISTORY.length > MAX_HISTORY) VIOLATION_HISTORY.shift();

    const waitSec = (backoffMs / 1000).toFixed(1);
    log.warning(
        `[RateLimitHandler] ${domain} — ${reason}` +
        (statusCode ? ` (HTTP ${statusCode})` : '') +
        ` | Attempt ${attempt} | Backing off ${waitSec}s`
    );
}

// ─── Violation Handler ────────────────────────────────────────────────────────

/**
 * Full violation handling pipeline:
 *   1. Increment attempt counter for domain.
 *   2. Calculate exponential backoff.
 *   3. Log the violation.
 *   4. Async-sleep for the backoff period.
 *
 * Await this before re-queueing a failed request.
 */
export async function handleViolation(
    domain: string,
    reason: string,
    statusCode: number | null = null
): Promise<void> {
    const maxAttempts = Number(process.env.MAX_BACKOFF_ATTEMPTS ?? 5);
    const attempt = Math.min(
        (domainAttempts.get(domain) ?? 0) + 1,
        maxAttempts
    );
    domainAttempts.set(domain, attempt);

    const backoffMs = getBackoffDelay(attempt, domain);
    logViolation(domain, reason, statusCode, backoffMs, attempt);

    await sleep(backoffMs);
}

/**
 * Signals that a domain has successfully responded — resets its attempt counter.
 */
export function recordSuccess(domain: string): void {
    domainAttempts.delete(domain);
}

// ─── History Accessor ─────────────────────────────────────────────────────────

/** Returns a copy of the violation history for the monitoring dashboard. */
export function getViolationHistory(): ViolationRecord[] {
    return [...VIOLATION_HISTORY];
}

/** Returns only violations for a specific domain. */
export function getViolationsForDomain(domain: string): ViolationRecord[] {
    return VIOLATION_HISTORY.filter((v) => v.domain === domain);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
