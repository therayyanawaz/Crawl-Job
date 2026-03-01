import { log } from 'crawlee';
import { gotScraping } from 'got-scraping';
import type { RawProxy } from './freeProxyFetcher.js';
import { toProxyUrl } from './freeProxyFetcher.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidatedProxy {
    url: string;            // Full proxy URL ready for Crawlee
    host: string;
    port: number;
    protocol: string;
    source: string;
    responseTimeMs: number; // Measured during validation
    anonymity: 'elite' | 'anonymous' | 'transparent' | 'unknown';
}

export interface ProxyValidationOptions {
    /**
     * URL to send the test request through each proxy.
     * httpbin.org/ip echoes back the requesting IP so we can confirm
     * the proxy is actually hiding our real IP.
     */
    testUrl?: string;
    /** How many milliseconds before we consider the proxy too slow. */
    timeoutMs?: number;
    /** Maximum acceptable round-trip time in milliseconds. */
    maxResponseTimeMs?: number;
    /**
     * Your real public IP address.  If provided, we can confirm the proxy
     * is genuinely masking you (anonymity check).
     * Obtain once at startup: curl https://httpbin.org/ip
     */
    realIp?: string;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

async function detectAnonymity(
    reportedIp: string,
    realIp: string | undefined
): Promise<ValidatedProxy['anonymity']> {
    if (!realIp) return 'unknown';
    // If the proxied response echoes our real IP the proxy is transparent
    if (reportedIp.includes(realIp)) return 'transparent';
    return 'elite'; // Simplified: not leaking real IP = good enough for scraping
}

// ─── Core Validator ───────────────────────────────────────────────────────────

/**
 * Tests a single raw proxy and returns a ValidatedProxy if it passes,
 * or null if it is dead, too slow, or transparent.
 *
 * Design choice: we never throw. The caller gets null for any failure,
 * keeping the batch validation loop clean.
 */
export async function validateProxy(
    proxy: RawProxy,
    options: ProxyValidationOptions = {}
): Promise<ValidatedProxy | null> {
    const {
        testUrl = 'https://httpbin.org/ip',
        timeoutMs = 8000,
        maxResponseTimeMs = 6000,
        realIp,
    } = options;

    const proxyUrl = toProxyUrl(proxy);
    const start = Date.now();

    try {
        const response = await Promise.race([
            gotScraping({
                url: testUrl,
                proxyUrl,
                responseType: 'json',
                timeout: { request: timeoutMs },
                retry: { limit: 0 }, // One shot – bail immediately on failure
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Hard timeout')), timeoutMs)
            )
        ]);

        const elapsed = Date.now() - start;

        if (response.statusCode !== 200) return null;
        if (elapsed > maxResponseTimeMs) {
            log.debug(`[Validator] Proxy too slow (${elapsed}ms): ${proxyUrl}`);
            return null;
        }

        const body = response.body as any;
        const reportedIp: string = body?.origin ?? '';
        const anonymity = await detectAnonymity(reportedIp, realIp);

        // Transparent proxies still expose your real IP – reject them (unless manual/paid proxy)
        if (anonymity === 'transparent' && proxy.source !== 'manual') {
            log.debug(`[Validator] Transparent proxy rejected: ${proxyUrl}`);
            return null;
        }

        return {
            url: proxyUrl,
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            source: proxy.source,
            responseTimeMs: elapsed,
            anonymity,
        };
    } catch (err: any) {
        // Network error, DNS failure, ETIMEDOUT, ECONNREFUSED …
        let message = err.message || 'Unknown error';

        // Clean up common verbose error messages (strip long bodies/HTML)
        if (message.includes('Proxy responded with')) {
            message = message.split(':')[0]; // Keep only the status line (e.g. "400 Bad Request")
        }

        if (proxy.source === 'manual') {
            log.warning(`[Validator] Manual proxy validation failed (${proxyUrl}): ${message}`);
        } else {
            log.debug(`[Validator] Proxy failed: ${message}`);
        }
        return null;
    }
}

// ─── Batch Validator ──────────────────────────────────────────────────────────

/**
 * Validates an array of raw proxies concurrently up to a configurable
 * parallelism limit.  We chunk the work rather than running all validations
 * at once, which would otherwise flood a 2-4 GB RAM server.
 *
 * @param rawProxies  List returned by fetchAllFreeProxies()
 * @param options     Shared validation options applied to every proxy
 * @param chunkSize   How many proxies to test at once (default 20)
 * @returns           Sorted list of working proxies, fastest first
 */
export async function validateProxies(
    rawProxies: RawProxy[],
    options: ProxyValidationOptions = {},
    chunkSize = 20
): Promise<ValidatedProxy[]> {
    log.info(`Validating ${rawProxies.length} proxies (chunk size: ${chunkSize})...`);

    const results: ValidatedProxy[] = [];

    // Process in chunks to avoid flooding the network adapter / eating RAM
    for (let i = 0; i < rawProxies.length; i += chunkSize) {
        const chunk = rawProxies.slice(i, i + chunkSize);
        const chunkResults = await Promise.allSettled(
            chunk.map((p) => validateProxy(p, options))
        );

        for (const r of chunkResults) {
            if (r.status === 'fulfilled' && r.value !== null) {
                results.push(r.value);
            }
        }

        const pct = Math.min(100, Math.round(((i + chunkSize) / rawProxies.length) * 100));
        log.info(`[Validator] Progress: ${pct}% — ${results.length} alive so far.`);
    }

    // Sort by speed: fastest proxy first in the Crawlee rotation
    results.sort((a, b) => a.responseTimeMs - b.responseTimeMs);

    log.info(
        `Validation complete. ${results.length}/${rawProxies.length} proxies passed ` +
        `(${Math.round((results.length / rawProxies.length) * 100)}% success rate).`
    );

    return results;
}

// ─── Periodic Re-validator ────────────────────────────────────────────────────

/**
 * Drops any ValidatedProxy whose re-test now fails.
 * Call this every N minutes during a long crawl to evict burned proxies.
 *
 * @param currentPool  Array currently in use by the crawler
 * @param options      Same options used at startup
 * @returns            Subset that still pass validation
 */
export async function revalidatePool(
    currentPool: ValidatedProxy[],
    options: ProxyValidationOptions = {}
): Promise<ValidatedProxy[]> {
    log.info(`Re-validating ${currentPool.length} active proxies...`);

    const asRaw: RawProxy[] = currentPool.map((p) => {
        const parsed = new URL(p.url);
        return {
            host: p.host,
            port: p.port,
            protocol: p.protocol as RawProxy['protocol'],
            source: p.source,
            username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
            password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        };
    });

    const stillAlive = await validateProxies(asRaw, options, 10);
    const dropped = currentPool.length - stillAlive.length;

    if (dropped > 0) {
        log.warning(`[Re-validation] Dropped ${dropped} burned/dead proxies from active pool.`);
    } else {
        log.info('[Re-validation] All proxies still healthy.');
    }

    return stillAlive;
}
