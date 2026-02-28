/**
 * src/main.ts
 *
 * ENTRY POINT — Job Crawler with Tiered Strategy
 *
 * PROXY-AWARE STRATEGY
 * ─────────────────────
 *  1. Paid/residential proxies (detected by URL pattern) → Run ALL tiers including
 *     headless Playwright with aggressive resource blocking for stealth + speed.
 *  2. Free proxies → Run Tiers 1-3 (HTTP/API only). Tier 4 headless ONLY runs
 *     if Tiers 1-3 yield insufficient data, with conservative concurrency.
 *
 * LOGGING
 * ───────
 *  • log.txt is truncated (overwritten) at the start of every run.
 *  • All stdout/stderr is mirrored to log.txt in real-time.
 *
 * DATABASE
 * ────────
 *  • All data is inserted into the `attack` database via PostgreSQL.
 */

import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';
import { router } from './routes';
import { fetchAllFreeProxies } from './utils/freeProxyFetcher';
import { validateProxies, revalidatePool, ValidatedProxy } from './utils/proxyValidator';
import { initDedupStore, closeDedupStore } from './utils/dedupStore';
import { logDedupSummary } from './utils/dedup';
import {
    initMetrics, closeMetrics, logMetricsSummary,
    recordRequestStarted, recordRequestSuccess, recordRequestFailed,
    recordRateLimitHit, recordProxyFailure,
} from './utils/metrics';
import { logHealthReport, writeHealthReport } from './utils/healthCheck';
import { sendAlert, alertOnHealthReport, sendStartupAlert, sendCompletionAlert } from './utils/alerts';
import {
    init as initDomainQueue,
    canProceed,
    recordRequest,
    releaseRequest,
    cleanup as cleanupDomainQueue,
} from './utils/domainQueue';
import {
    getRateLimitConfig,
    getDelayForDomain,
    extractDomain,
    isOffHoursIST,
} from './config/rateLimits';
import {
    detectRateLimitByStatus,
    isBlocked,
    handleViolation,
    recordSuccess,
} from './utils/rateLimitHandler';
import {
    printCurrentStatus,
    printViolationHistory,
    printRecommendations,
    exportReport,
} from './utils/rateLimitMonitor';
import { pingDb, closeDb } from './utils/db';
import { countJobsInDb } from './utils/jobStore';
import { runOrchestrator } from './orchestrator';
import { initFileLogger, closeFileLogger } from './utils/fileLogger';
import type { SearchQuery } from './sources/types';
import 'dotenv/config';

// ─── File Logger (MUST be first — truncates log.txt) ──────────────────────────
initFileLogger();

// ─── Logging ──────────────────────────────────────────────────────────────────
const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');
if (isVerbose) {
    process.env.CRAWLEE_LOG_LEVEL = 'DEBUG';
}

log.setLevel(
    process.env.CRAWLEE_LOG_LEVEL
        ? (log.LEVELS as any)[process.env.CRAWLEE_LOG_LEVEL.toUpperCase()] ?? log.LEVELS.INFO
        : log.LEVELS.INFO
);

// ─── Constants ────────────────────────────────────────────────────────────────

const PROXY_MIN_COUNT = Number(process.env.PROXY_MIN_COUNT ?? 5);
const PROXY_REFRESH_INTERVAL_MS = Number(process.env.PROXY_REFRESH_INTERVAL_MINUTES ?? 15) * 60_000;
const ENABLE_RATE_LIMITING = process.env.ENABLE_DOMAIN_RATE_LIMITING !== 'false';

const STATUS_REPORT_INTERVAL_MS = 10 * 60_000;
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 5 * 60_000);

// ─── Paid Proxy Detection ─────────────────────────────────────────────────────

/**
 * Heuristic to detect if the configured PROXY_URLS contain paid/residential
 * proxies (like Webshare, Oxylabs, BrightData, SmartProxy).
 *
 * Paid proxies:  → enable aggressive headless scraping (safe from bans)
 * Free proxies:  → conservative HTTP-only mode to avoid burning IPs
 */
function detectPaidProxy(): boolean {
    const raw = process.env.PROXY_URLS ?? '';
    if (!raw) return false;

    const paidIndicators = [
        'webshare.io',
        'oxylabs.',
        'brightdata.',
        'smartproxy.',
        'zyte.com',
        'storm-',
        'residential',
        '-rotate',
        'superproxy.',
        'iproyal.',
        'proxy-seller.',
        'proxy.google',
    ];

    const lower = raw.toLowerCase();
    return paidIndicators.some(ind => lower.includes(ind));
}

// ─── Search Queries ───────────────────────────────────────────────────────────

function getSearchQueries(): SearchQuery[] {
    const queriesEnv = process.env.SEARCH_QUERIES;
    if (queriesEnv) {
        try {
            return JSON.parse(queriesEnv);
        } catch {
            log.warning('[Config] Could not parse SEARCH_QUERIES JSON. Using defaults.');
        }
    }

    return [
        { keywords: 'software developer fresher', location: 'India', maxResults: 50 },
        { keywords: 'software engineer intern', location: 'India', maxResults: 50 },
        { keywords: 'web developer junior', location: 'India', maxResults: 30 },
        { keywords: 'data analyst fresher', location: 'India', maxResults: 30 },
    ];
}

// ─── Sleep Helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Proxy Bootstrap ──────────────────────────────────────────────────────────

async function buildProxyPool(): Promise<ValidatedProxy[]> {
    let realIp: string | undefined;
    try {
        const { gotScraping } = await import('got-scraping');
        const r = await gotScraping({
            url: 'https://httpbin.org/ip',
            responseType: 'json',
            timeout: { request: 5000 },
        });
        realIp = (r.body as any)?.origin;
        log.info(`Real server IP detected: ${realIp}`);
    } catch {
        log.warning('Could not detect real IP — anonymity filtering disabled.');
    }

    const validationOpts = {
        testUrl: 'https://httpbin.org/ip',
        timeoutMs: 10000,
        maxResponseTimeMs: 8000,
        realIp,
    };

    const manualRaw = (process.env.PROXY_URLS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    let validPool: ValidatedProxy[] = [];

    if (manualRaw.length > 0) {
        log.info(`Validating ${manualRaw.length} manually-configured proxies…`);
        const asRaw = manualRaw.map((url) => {
            const parsed = new URL(url);
            return {
                host: parsed.hostname,
                port: Number(parsed.port),
                protocol: parsed.protocol.replace(':', '') as any,
                source: 'manual',
                username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
                password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
            };
        });
        validPool = await validateProxies(asRaw, validationOpts, 10);
        log.info(`Manual proxies passing validation: ${validPool.length}/${manualRaw.length}`);
    }

    if (validPool.length < PROXY_MIN_COUNT) {
        log.info(
            `Pool has ${validPool.length} proxies (min ${PROXY_MIN_COUNT}). Fetching free lists…`
        );
        const freeRaw = await fetchAllFreeProxies();
        const freeValid = await validateProxies(freeRaw, validationOpts, 20);
        const existing = new Set(validPool.map((p) => p.url));
        for (const fp of freeValid) {
            if (!existing.has(fp.url)) validPool.push(fp);
        }
        log.info(`Combined pool after top-up: ${validPool.length} proxies.`);
    }

    if (validPool.length < PROXY_MIN_COUNT) {
        log.error(
            `Only ${validPool.length} proxies found (need ${PROXY_MIN_COUNT}). ` +
            'Add paid proxies to PROXY_URLS or retry later.'
        );
        process.exit(1);
    }

    return validPool;
}

// ─── Headless Crawler (Tier 4) ────────────────────────────────────────────────

/**
 * Runs the Playwright-based headless crawler for Indeed + LinkedIn.
 *
 * STEALTH AUTOMATION FEATURES:
 *  • Browser fingerprint randomisation (useFingerprints: true)
 *  • Resource blocking (images, fonts, stylesheets) for paid proxies — reduces
 *    bandwidth fingerprint and speeds up page loads
 *  • Random viewport sizes to avoid fingerprint correlation
 *  • Human-like delays in pre-navigation hooks
 *  • Session retirement on 403/429 responses
 *  • Domain-specific concurrency and rate limits
 *
 * @param validPool   The validated proxy URLs
 * @param hasPaidProxy Whether to use aggressive (paid) or conservative (free) mode
 */
async function runHeadlessCrawler(
    validPool: ValidatedProxy[],
    hasPaidProxy: boolean
): Promise<void> {
    log.info('\n' + '═'.repeat(60));
    log.info(`  TIER 4: HEADLESS BROWSER (Indeed + LinkedIn)`);
    log.info(`  Mode: ${hasPaidProxy ? 'AGGRESSIVE (paid proxy — resource blocking ON)' : 'CONSERVATIVE (free proxy — stealth mode)'}`);
    log.info('═'.repeat(60) + '\n');

    const proxyConfiguration = new ProxyConfiguration({
        proxyUrls: validPool.map((p) => p.url),
    });

    // ── Background timers ─────────────────────────────────────────────────────

    const proxyTimer = setInterval(async () => {
        log.info('[Scheduler] Revalidating proxy pool…');
        validPool = await revalidatePool(validPool);
        if (validPool.length < PROXY_MIN_COUNT) {
            const freshRaw = await fetchAllFreeProxies();
            const freshValid = await validateProxies(freshRaw, { timeoutMs: 10000, maxResponseTimeMs: 8000 }, 20);
            validPool.push(...freshValid.filter((p) => !validPool.some((e) => e.url === p.url)));
            log.info(`[Scheduler] Pool replenished to ${validPool.length} proxies.`);
            if (validPool.length < PROXY_MIN_COUNT) {
                recordProxyFailure();
                await sendAlert('critical', 'Proxy pool critically low after replenishment', {
                    poolSize: validPool.length, minimum: PROXY_MIN_COUNT,
                });
            }
        }
    }, PROXY_REFRESH_INTERVAL_MS);

    const monitorTimer = setInterval(async () => {
        await printCurrentStatus();
        printViolationHistory();
        await printRecommendations();
    }, STATUS_REPORT_INTERVAL_MS);

    const healthTimer = setInterval(async () => {
        logMetricsSummary();
        const report = logHealthReport();
        writeHealthReport(report);
        await alertOnHealthReport(report);
    }, HEALTH_CHECK_INTERVAL_MS);

    // ── Concurrency strategy ──────────────────────────────────────────────────
    // Paid proxy → up to 5 concurrent pages (fast, distributed IPs)
    // Free proxy → max 2 (avoid burning cheap IPs)
    const maxConcurrency = hasPaidProxy
        ? Math.min(Number(process.env.HEADLESS_MAX_CONCURRENCY ?? 5), validPool.length)
        : Math.min(2, validPool.length);

    // ── Random viewport pool (anti-fingerprint) ───────────────────────────────
    const viewports = [
        { width: 1920, height: 1080 },
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1280, height: 720 },
    ];

    const crawler = new PlaywrightCrawler({
        requestHandler: router,
        proxyConfiguration,
        headless: true,

        browserPoolOptions: {
            useFingerprints: true,
        },
        sessionPoolOptions: {
            maxPoolSize: Math.max(validPool.length * 3, 30),
            sessionOptions: {
                maxUsageCount: hasPaidProxy ? 30 : 10,  // paid proxies can sustain more reuse
                maxErrorScore: 2,
            },
        },
        launchContext: {
            launchOptions: {
                args: [
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-accelerated-2d-canvas',
                    '--disable-web-security',
                    '--disable-blink-features=AutomationControlled',
                ],
            },
        },

        maxConcurrency,
        minConcurrency: 1,
        maxRequestRetries: hasPaidProxy ? 5 : 2,
        requestHandlerTimeoutSecs: 120,

        // ── Pre-Navigation Hook ───────────────────────────────────────────────
        preNavigationHooks: [
            async ({ request, log: hookLog, page }, gotoOptions) => {
                recordRequestStarted();

                // Anti-detection: randomise viewport per page
                const vp = viewports[Math.floor(Math.random() * viewports.length)];
                await page.setViewportSize(vp);

                // Anti-detection: override navigator.webdriver
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    // Fake plugins array
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                    // Fake languages
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en'],
                    });
                });

                // Resource blocking — STRATEGY.md § 2, TIER 2
                // Uses Crawlee's built-in blockRequests() — blocks by URL pattern
                // Reduces bandwidth fingerprint + speeds up page loads significantly
                await (page as any).route?.('**/*', () => { });  // ensure page context exists
                try {
                    await page.route('**/*', (route) => {
                        const url = route.request().url();
                        const type = route.request().resourceType();

                        // Always block: tracking, analytics, ads
                        const blockPatterns = [
                            'google-analytics', 'facebook.net', 'hotjar',
                            'doubleclick', 'googlesyndication', 'googletagmanager',
                            'linkedin.com/li/track', 'bat.bing.com',
                        ];

                        if (blockPatterns.some(p => url.includes(p))) {
                            return route.abort();
                        }

                        // Paid proxy: also block images, fonts, stylesheets for speed
                        if (hasPaidProxy && ['image', 'stylesheet', 'font', 'media'].includes(type)) {
                            return route.abort();
                        }

                        return route.continue();
                    });
                } catch {
                    // page.route can fail if context is already closed — safe to ignore
                }

                if (!ENABLE_RATE_LIMITING) return;

                const domain = extractDomain(request.url);
                const config = getRateLimitConfig(domain);

                const gateStart = Date.now();
                const gateTimeoutMs = 2 * 60_000;
                while (!(await canProceed(domain))) {
                    if (Date.now() - gateStart > gateTimeoutMs) {
                        hookLog.warning(`[RateLimit] Gate timeout for ${domain} after 2 min. Proceeding anyway.`);
                        break;
                    }
                    await sleep(1_000);
                }

                await recordRequest(domain);

                // Free proxies get 2x the delay to avoid triggering blocks
                const baseDelay = getDelayForDomain(domain);
                const actualDelay = hasPaidProxy ? baseDelay : baseDelay * 2;
                hookLog.info(
                    `[RateLimit] ${domain} (${config.riskLevel}) — ` +
                    `waiting ${(actualDelay / 1000).toFixed(1)}s before navigation ` +
                    `(${hasPaidProxy ? 'paid' : 'free'} proxy mode).`
                );
                await sleep(actualDelay);

                const navTimeout =
                    config.riskLevel === 'HIGH' ? 60_000 :
                        config.riskLevel === 'MEDIUM' ? 45_000 : 30_000;
                gotoOptions.timeout = navTimeout;
                gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],

        // ── Post-Navigation Hook ──────────────────────────────────────────────
        postNavigationHooks: [
            async ({ request, response, page, log: hookLog }) => {
                const domain = extractDomain(request.url);
                await releaseRequest(domain);

                const startedAt = (request as any).__startedAt as number | undefined;
                if (startedAt) recordRequestSuccess(Date.now() - startedAt);
                else recordRequestSuccess(0);

                if (!ENABLE_RATE_LIMITING) return;

                if (response && detectRateLimitByStatus(response)) {
                    recordRateLimitHit();
                    await handleViolation(domain, 'HTTP rate-limit/block', response.status());
                    return;
                }

                const blocked = await isBlocked(page);
                if (blocked) {
                    recordRateLimitHit();
                    await handleViolation(domain, 'Soft block / CAPTCHA detected', null);
                    return;
                }

                recordSuccess(domain);
            },
        ],

        // ── Failed Request Handler (STRATEGY.md § 6 Error Rules) ────────────────
        failedRequestHandler: async ({ request, response, log: reqLog, session }) => {
            const domain = extractDomain(request.url);
            const status = response?.status();

            recordRequestFailed();

            // Rule 1: Soft block (429 Too Many Requests)
            if (status === 429) {
                reqLog.warning(`[${domain}] Rate limited (429) — backing off ${request.retryCount} min`);
                if (session) session.markBad();
                recordRateLimitHit();
                await handleViolation(domain, `HTTP 429 rate-limit`, status);
                // Exponential backoff: 1min × retry count (per strategy doc)
                await sleep(60_000 * Math.max(request.retryCount, 1));
            }

            // Rule 2: Hard block (403 Forbidden)
            else if (status === 403) {
                reqLog.error(`[${domain}] Hard blocked (403) — flagging for proxy escalation`);
                if (session) session.markBad();
                recordRateLimitHit();
                request.userData.needsResidentialProxy = true;
                await handleViolation(domain, `HTTP 403 hard block on final retry`, status);
            }

            // Rule 3: Proxy auth failure
            else if (status === 407) {
                reqLog.warning(`[${domain}] Proxy authentication required for ${request.url}.`);
                recordProxyFailure();
            }

            // Rule 4: Empty / malformed response
            else if (!status || status >= 500) {
                reqLog.error(
                    `[${domain}] Request permanently failed ` +
                    `(HTTP ${status ?? 'timeout/network'}): ${request.url}`
                );
            }

            else {
                reqLog.warning(`[${domain}] Unexpected status ${status}: ${request.url}`);
            }
        },
    });

    // ── Seed headless URLs — Indeed + LinkedIn ─────────────────────────────────
    const seedUrls = [
        { url: 'https://in.indeed.com/jobs?q=software+developer+fresher&l=India&sort=date', label: 'INDEED_HUB' },
        { url: 'https://in.indeed.com/jobs?q=software+engineer+intern&l=India&sort=date', label: 'INDEED_HUB' },
        { url: 'https://www.linkedin.com/jobs/search/?keywords=software+developer+fresher&location=India&sortBy=DD', label: 'LINKEDIN_HUB' },
        { url: 'https://www.linkedin.com/jobs/search/?keywords=software+engineer+intern&location=India&sortBy=DD', label: 'LINKEDIN_HUB' },
    ];

    log.info(`[Headless] Seeding ${seedUrls.length} start URLs for Indeed + LinkedIn`);
    await crawler.addRequests(seedUrls);

    try {
        await crawler.run();
    } finally {
        clearInterval(proxyTimer);
        clearInterval(monitorTimer);
        clearInterval(healthTimer);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runCrawler() {
    log.info('╔══════════════════════════════════════════════════════════════╗');
    log.info('║  Job Crawler — Full Tiered Strategy, Proxy-Rotated, Dedup  ║');
    log.info('╚══════════════════════════════════════════════════════════════╝');
    log.info(`Rate limiting : ${ENABLE_RATE_LIMITING ? 'ENABLED ✓' : 'DISABLED ⚠'}`);
    log.info(`IST off-hours : ${isOffHoursIST() ? 'YES — optimal crawl window' : 'NO — delays doubled for HIGH-risk domains'}`);
    log.info(`Database      : ${process.env.PGDATABASE ?? 'attack'}`);
    log.info(`Log file      : log.txt (truncated for this run)`);

    // Detect proxy type
    const hasPaidProxy = detectPaidProxy();
    log.info(`Proxy mode    : ${hasPaidProxy ? 'PAID ✓ (Headless always enabled)' : 'FREE/UNKNOWN (Headless conditional)'}`);

    // 0. Initialise subsystems
    initMetrics();
    initDomainQueue();

    // 1. Initialise persistent dedup store
    initDedupStore();

    // 2. Verify PostgreSQL connectivity
    log.info('[DB] Checking PostgreSQL connection to "attack" database…');
    const dbAlive = await pingDb();
    if (dbAlive) {
        const total = await countJobsInDb();
        log.info(`[DB] ✓ Connected to "attack". ${total >= 0 ? total + ' jobs in store.' : ''}`);
    } else {
        log.warning('[DB] ⚠ PostgreSQL unreachable — jobs will only be saved to local JSON. Check PGHOST/PGUSER/PGPASSWORD/PGDATABASE in .env');
    }

    // 3. Build proxy pool
    const validPool = await buildProxyPool();
    await sendStartupAlert(validPool.length);

    // 4. Get search queries
    const queries = getSearchQueries();
    log.info(`Search queries: ${queries.map(q => `"${q.keywords}"`).join(', ')}`);

    // 5. Run the tiered orchestrator (Tiers 1-3)
    const runStart = Date.now();
    const orchestratorResult = await runOrchestrator(queries, hasPaidProxy);

    // 6. If orchestrator says headless is needed, run Tier 4
    if (orchestratorResult.headlessNeeded) {
        log.info('\n' + '═'.repeat(60));
        log.info('  ACTIVATING TIER 4: HEADLESS BROWSER SCRAPING');
        log.info('  Indeed + LinkedIn via Playwright with stealth automation');
        log.info('═'.repeat(60));
        await runHeadlessCrawler(validPool, hasPaidProxy);
    } else {
        log.info('[Main] ✓ Sufficient data collected from Tiers 1-3. Headless skipped.');
    }

    // 7. Cleanup
    cleanupDomainQueue();
    logDedupSummary();
    closeDedupStore();

    // Final metrics + health snapshot
    logMetricsSummary();
    const finalReport = logHealthReport();
    writeHealthReport(finalReport);
    closeMetrics();

    // Final rate-limit report
    log.info('=== Final Rate-Limit Report ===');
    await printCurrentStatus();
    printViolationHistory();
    await printRecommendations();
    await exportReport();

    // Completion alert
    const { jobsExtracted } = finalReport.snapshot;
    await sendCompletionAlert(jobsExtracted, Math.round((Date.now() - runStart) / 1000));

    // Close DB pool
    await closeDb();

    // Close file logger
    closeFileLogger();

    log.info('Crawler pipeline completed.');
}

runCrawler().catch((err) => {
    console.error('[FATAL]', err);
    closeFileLogger();
    process.exit(1);
});
