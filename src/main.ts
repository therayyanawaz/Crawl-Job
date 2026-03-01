/**
 * src/main.ts
 *
 * ENTRY POINT — Crawl-Job with Tiered Strategy
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
 *  • All data is inserted into the `crawl_job` database via PostgreSQL.
 */

import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';
import { router } from './routes.js';
import { fetchAllFreeProxies } from './utils/freeProxyFetcher.js';
import { validateProxies, revalidatePool, ValidatedProxy } from './utils/proxyValidator.js';
import { initDedupStore, closeDedupStore } from './utils/dedupStore.js';
import { logDedupSummary } from './utils/dedup.js';
import {
    initMetrics, closeMetrics, logMetricsSummary,
    recordRequestStarted, recordRequestSuccess, recordRequestFailed,
    recordRateLimitHit, recordProxyFailure,
} from './utils/metrics.js';
import { logHealthReport, writeHealthReport } from './utils/healthCheck.js';
import { sendAlert, alertOnHealthReport, sendStartupAlert, sendCompletionAlert } from './utils/alerts.js';
import {
    init as initDomainQueue,
    canProceed,
    recordRequest,
    releaseRequest,
    cleanup as cleanupDomainQueue,
} from './utils/domainQueue.js';
import {
    getRateLimitConfig,
    getDelayForDomain,
    extractDomain,
    isOffHoursIST,
} from './config/rateLimits.js';
import {
    detectRateLimitByStatus,
    isBlocked,
    handleViolation,
    recordSuccess,
} from './utils/rateLimitHandler.js';
import {
    printCurrentStatus,
    printViolationHistory,
    printRecommendations,
    exportReport,
} from './utils/rateLimitMonitor.js';
import { pingDb, closeDb } from './utils/db.js';
import { countJobsInDb, saveJobToDb } from './utils/jobStore.js';
import type { StorableJob } from './utils/jobStore.js';
import { runOrchestrator } from './orchestrator.js';
import { initFileLogger, closeFileLogger, initJsonLogger, closeJsonLogger, logStructured } from './utils/fileLogger.js';
import { createRunContext } from './utils/runContext.js';
import { isDuplicateJob, markJobAsStored } from './utils/dedup.js';
import type { SearchQuery, RawJobListing } from './sources/types.js';
import { fetchHimalayasRss } from './sources/himalayasRss.js';
import { checkOllamaHealth, setOllamaAvailable, isOllamaAvailable } from './services/ollamaExtractor.js';
import { detectPaidProxy } from './utils/proxyUtils.js';
import { ensureRequestInterception } from './utils/requestInterception.js';
import { getRequestLatencyMs, markRequestStart } from './utils/requestTiming.js';
import 'dotenv/config';
import { env } from './config/env.js';

// ─── Global tracker: how many jobs came from APIs (for health check) ──────────
let apiJobsCount = 0;
export function getApiJobsCount(): number { return apiJobsCount; }

// ─── File Logger (MUST be first — truncates log.txt) ──────────────────────────
initFileLogger();

// ─── Logging ──────────────────────────────────────────────────────────────────
const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');
if (isVerbose) {
    env.CRAWLEE_LOG_LEVEL = 'DEBUG';
}

log.setLevel(
    env.CRAWLEE_LOG_LEVEL
        ? (log.LEVELS as any)[env.CRAWLEE_LOG_LEVEL.toUpperCase()] ?? log.LEVELS.INFO
        : log.LEVELS.INFO
);

// ─── Constants ────────────────────────────────────────────────────────────────

const PROXY_MIN_COUNT = env.PROXY_MIN_COUNT;
const PROXY_REFRESH_INTERVAL_MS = env.PROXY_REFRESH_INTERVAL_MINUTES * 60_000;
const ENABLE_RATE_LIMITING = env.ENABLE_DOMAIN_RATE_LIMITING;

const STATUS_REPORT_INTERVAL_MS = 10 * 60_000;
const HEALTH_CHECK_INTERVAL_MS = env.HEALTH_CHECK_INTERVAL_MS;

// ─── Search Queries ───────────────────────────────────────────────────────────

function getSearchQueries(): SearchQuery[] {
    const queriesEnv = env.SEARCH_QUERIES;
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

function markDomainSlotAcquired(request: any, domain: string): void {
    request.userData = request.userData ?? {};
    request.userData.__domainQueueDomain = domain;
    request.userData.__domainQueueAcquired = true;
}

async function releaseDomainSlotIfAcquired(request: any): Promise<void> {
    const userData = request?.userData;
    if (!userData?.__domainQueueAcquired || !userData.__domainQueueDomain) {
        return;
    }

    await releaseRequest(userData.__domainQueueDomain);
    userData.__domainQueueAcquired = false;
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

    const manualRaw = (env.PROXY_URLS ?? '')
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
                port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
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

// ─── Headless Crawler (Tier 2) ────────────────────────────────────────────────

/**
 * Runs the Playwright-based headless crawler.
 *
 * PRIMARY TARGETS: Cutshort, Foundit, Shine, TimesJobs, Wellfound (always active)
 * OPTIONAL:        Indeed, LinkedIn (env-gated: ENABLE_INDEED / ENABLE_LINKEDIN)
 *
 * STEALTH AUTOMATION FEATURES:
 *  • Browser fingerprint randomisation
 *  • Resource blocking (analytics, tracking always; images/fonts for paid proxies)
 *  • Random viewport sizes
 *  • Cookie domain isolation (fixes SessionPool contamination)
 *  • Human-like delays
 *  • Session retirement on 403/429
 *  • Domain-specific concurrency and rate limits
 */
async function runHeadlessCrawler(
    validPool: ValidatedProxy[],
    hasPaidProxy: boolean
): Promise<void> {
    log.info('\n' + '═'.repeat(60));
    log.info(`  TIER 2: HEADLESS BROWSER SCRAPING`);
    log.info(`  Targets: Cutshort ✓ | Foundit ✓ | Shine ✓ | TimesJobs ✓ | Wellfound ✓`);
    const enableIndeed = env.ENABLE_INDEED;
    const enableLinkedin = env.ENABLE_LINKEDIN;
    if (enableIndeed) log.info(`  Indeed: ENABLED (ENABLE_INDEED=true)`);
    if (enableLinkedin) log.info(`  LinkedIn: ENABLED (ENABLE_LINKEDIN=true)`);
    if (enableLinkedin && !env.LINKEDIN_COOKIE) {
        log.warning(`  WARN: LinkedIn crawl enabled but no LINKEDIN_COOKIE env var set — will return 0 cards`);
    }
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
        ? Math.min(env.HEADLESS_MAX_CONCURRENCY, validPool.length)
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
            async ({ request, log: hookLog, page, session }, gotoOptions) => {
                recordRequestStarted();

                // ── PART 3 FIX: Cookie domain isolation ──────────────────────────
                // Prevent SessionPool from leaking cross-domain cookies
                // (e.g. Indeed cookies going to LinkedIn requests)
                try {
                    const requestHost = new URL(request.url).hostname;
                    const cookies = await page.context().cookies();
                    const foreignCookies = cookies.filter(
                        c => c.domain && !requestHost.endsWith(c.domain.replace(/^\./, ''))
                    );
                    if (foreignCookies.length > 0) {
                        hookLog.debug(`[CookieFix] Clearing ${foreignCookies.length} cross-domain cookies for ${requestHost}`);
                        await page.context().clearCookies();
                        const validCookies = cookies.filter(
                            c => !c.domain || requestHost.endsWith(c.domain.replace(/^\./, ''))
                        );
                        if (validCookies.length > 0) {
                            await page.context().addCookies(validCookies);
                        }
                    }
                } catch {
                    // Cookie isolation is best-effort — don't crash the request
                }

                // Anti-detection: randomise viewport per page
                const vp = viewports[Math.floor(Math.random() * viewports.length)];
                await page.setViewportSize(vp);

                // Anti-detection: override navigator.webdriver
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en'],
                    });
                });

                // Resource blocking (idempotent): register request interception once per page.
                try {
                    await ensureRequestInterception(page as any, hasPaidProxy);
                } catch {
                    // page.route can fail if context is already closed — safe to ignore
                }

                if (!ENABLE_RATE_LIMITING) {
                    markRequestStart(request);
                    return;
                }

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
                markDomainSlotAcquired(request, domain);

                try {
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
                    markRequestStart(request);
                } catch (err) {
                    await releaseDomainSlotIfAcquired(request);
                    throw err;
                }
            },
        ],

        // ── Post-Navigation Hook ──────────────────────────────────────────────
        postNavigationHooks: [
            async ({ request, response, page, log: hookLog }) => {
                try {
                    const latencyMs = getRequestLatencyMs(request);
                    recordRequestSuccess(latencyMs ?? undefined);

                    if (!ENABLE_RATE_LIMITING) return;

                    const domain = extractDomain(request.url);

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
                } finally {
                    await releaseDomainSlotIfAcquired(request);
                }
            },
        ],

        // ── Failed Request Handler (STRATEGY.md § 6 Error Rules) ────────────────
        failedRequestHandler: async ({ request, response, log: reqLog, session }) => {
            try {
                const domain = extractDomain(request.url);
                const status = response?.status();

                recordRequestFailed();

                // Rule 1: Soft block (429 Too Many Requests)
                if (status === 429) {
                    reqLog.warning(`[${domain}] Rate limited (429) — backing off ${request.retryCount} min`);
                    if (session) session.markBad();
                    recordRateLimitHit();
                    await handleViolation(domain, `HTTP 429 rate-limit`, status);
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
            } finally {
                await releaseDomainSlotIfAcquired(request);
            }
        },
    });

    // ── Seed headless URLs — PRIMARY targets: Cutshort, Foundit, Shine, TimesJobs, Wellfound ─────────
    const seedUrls: Array<{ url: string; label: string }> = [
        // Cutshort.io
        { url: 'https://cutshort.io/jobs?keywords=software+developer&experience=0-1', label: 'CUTSHORT_HUB' },
        { url: 'https://cutshort.io/jobs?keywords=software+engineer+intern&experience=0-1', label: 'CUTSHORT_HUB' },
        // Foundit.in (ex-Monster India)
        { url: 'https://www.foundit.in/srp/results?query=software+developer+fresher&location=India', label: 'FOUNDIT_HUB' },
        { url: 'https://www.foundit.in/srp/results?query=software+engineer+intern&location=India', label: 'FOUNDIT_HUB' },
        // Shine.com
        { url: 'https://www.shine.com/job-search/fresher-software-developer-jobs/?q=software+developer&experience=0', label: 'SHINE_HUB' },
        { url: 'https://www.shine.com/job-search/software-engineer-intern-jobs/?q=software+engineer+intern&experience=0', label: 'SHINE_HUB' },
        // TimesJobs
        { url: 'https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=software+developer&txtLocation=&sequence=1&startPage=1', label: 'TIMESJOBS_HUB' },
        { url: 'https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=software+engineer+intern&txtLocation=&sequence=1&startPage=1', label: 'TIMESJOBS_HUB' },
        // Wellfound
        { url: 'https://wellfound.com/jobs', label: 'WELLFOUND_HUB' },
    ];

    // ── OPTIONAL targets (env-gated) ──────────────────────────────────────────
    if (enableIndeed) {
        seedUrls.push(
            { url: 'https://in.indeed.com/jobs?q=software+developer+fresher&l=India&sort=date', label: 'INDEED_HUB' },
            { url: 'https://in.indeed.com/jobs?q=software+engineer+intern&l=India&sort=date', label: 'INDEED_HUB' },
        );
    }
    if (enableLinkedin) {
        seedUrls.push(
            { url: 'https://www.linkedin.com/jobs/search/?keywords=software+developer+fresher&location=India&sortBy=DD', label: 'LINKEDIN_HUB' },
            { url: 'https://www.linkedin.com/jobs/search/?keywords=software+engineer+intern&location=India&sortBy=DD', label: 'LINKEDIN_HUB' },
        );
    }

    const activeTargets = ['Cutshort', 'Foundit', 'Shine', 'TimesJobs', 'Wellfound'];
    if (enableIndeed) activeTargets.push('Indeed');
    if (enableLinkedin) activeTargets.push('LinkedIn');
    log.info(`[Headless] Seeding ${seedUrls.length} start URLs for: ${activeTargets.join(', ')}`);
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
    const ctx = createRunContext();
    initJsonLogger(ctx.runId);
    const enableIndeed = env.ENABLE_INDEED;
    const enableLinkedin = env.ENABLE_LINKEDIN;

    log.info('╔══════════════════════════════════════════════════════════════╗');
    log.info('║  Crawl-Job — Multi-Platform, API-First, Tiered Strategy  ║');
    log.info('╚══════════════════════════════════════════════════════════════╝');

    // Part 5: Active sources status line
    const srcStatus = [
        'HimalayasRSS✓',
        'Cutshort✓', 'Foundit✓', 'Shine✓', 'TimesJobs✓', 'Wellfound✓',
        `LinkedIn${enableLinkedin ? '✓' : '✗'}`,
        `Indeed${enableIndeed ? '✓' : '✗'}`,
        'Ollama-LLM(pending)',
    ];
    log.info(`[Sources] Active: ${srcStatus.join(' | ')}`);

    log.info(`Rate limiting : ${ENABLE_RATE_LIMITING ? 'ENABLED ✓' : 'DISABLED ⚠'}`);
    log.info(`IST off-hours : ${isOffHoursIST() ? 'YES — optimal crawl window' : 'NO — delays doubled for HIGH-risk domains'}`);
    log.info(`Database      : ${env.PGDATABASE}`);
    log.info(`Log file      : log.txt (truncated for this run)`);

    const hasPaidProxy = detectPaidProxy();
    log.info(`Proxy mode    : ${hasPaidProxy ? 'PAID ✓ (Headless always enabled)' : 'FREE/UNKNOWN (Headless conditional)'}`);
    log.info(`Ollama LLM    : checking at startup… (${env.OLLAMA_BASE_URL})`);

    // ── Termination Handling ──────────────────────────────────────────────────
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        log.info(`\n[Main] 🛑 Received ${signal}. Shutting down gracefully...`);

        try {
            cleanupDomainQueue();
            logDedupSummary();
            closeDedupStore();
            closeMetrics();
            await closeDb();
            log.info('[Main] Cleanup complete. Exiting.');
        } catch (err) {
            console.error('[Main] Cleanup failed during shutdown:', err);
        }
        logStructured('info', 'Shutdown initiated', {
            service: 'main',
            event: 'shutdown',
            signal,
        });
        closeJsonLogger();
        closeFileLogger();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Optional: terminate with 'q' key if running in a TTY
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (key: string) => {
            if (key === 'q' || key === 'Q') {
                shutdown('manual trigger (q key)');
            }
            // Preserve Ctrl+C functionality in raw mode
            if (key === '\u0003') {
                shutdown('SIGINT (Ctrl+C)');
            }
        });
        log.info('[Main] Press "q" to stop the crawler gracefully.');
    }

    // 0. Initialise subsystems
    initMetrics();
    initDomainQueue();
    initDedupStore();

    // 0b. Ollama health check — set OLLAMA_AVAILABLE flag
    log.info('[Ollama] Checking Ollama availability…');
    const ollamaHealthy = await checkOllamaHealth();
    setOllamaAvailable(ollamaHealthy);
    if (ollamaHealthy) {
        log.info('[Ollama] ✅ LLM extraction ENABLED — Ollama will process page HTML');
    } else {
        log.warning('[Ollama] ⚠ Ollama not available — falling back to CSS selector extraction');
        log.warning('[Ollama]   To enable: ollama serve && ollama pull ' + env.OLLAMA_MODEL);
    }
    logStructured('info', 'Ollama health check', {
        service: 'ollama',
        status: ollamaHealthy ? 'ok' : 'unavailable',
    });

    // 1. Verify PostgreSQL connectivity
    log.info('[DB] Checking PostgreSQL connection to "crawl_job" database…');
    const dbAlive = await pingDb();
    if (dbAlive) {
        const total = await countJobsInDb();
        log.info(`[DB] ✓ Connected to "crawl_job". ${total >= 0 ? total + ' jobs in store.' : ''}`);
    } else {
        log.warning('[DB] ⚠ PostgreSQL unreachable — jobs will only be saved to local JSON.');
    }
    logStructured('info', 'Database connectivity', {
        service: 'db',
        status: dbAlive ? 'ok' : 'unreachable',
    });

    // ── PART 1: Run FREE API sources FIRST (no Playwright needed) ─────────────
    const queries = getSearchQueries();
    log.info(`\n${'─'.repeat(60)}`);
    log.info('  TIER 0 (PRE): Free API/RSS Sources — HimalayasRSS');
    log.info(`${'─'.repeat(60)}`);

    const apiResults = await Promise.allSettled([
        fetchHimalayasRss(queries[0]),
    ]);

    // Persist API results through dedup pipeline (skip DomainQueue as specified)
    for (const result of apiResults) {
        if (result.status === 'fulfilled' && result.value) {
            const sr = result.value;
            for (const job of sr.jobs) {
                const record: any = { ...job, scrapedAt: new Date().toISOString() };
                const { isDuplicate } = await isDuplicateJob(record);
                if (!isDuplicate) {
                    void markJobAsStored(record);
                    saveJobToDb(record as StorableJob).catch(() => null);
                    apiJobsCount++;
                }
            }
            log.info(`[API] ${sr.source}: ${sr.jobs.length} jobs fetched, ${sr.error ? 'ERROR: ' + sr.error : 'OK'}`);
        }
    }
    log.info(`[API] Total API jobs stored: ${apiJobsCount}`);

    // 2. Build proxy pool
    const validPool = await buildProxyPool();
    logStructured('info', 'Proxy pool ready', {
        service: 'proxy',
        poolSize: validPool.length,
    });
    await sendStartupAlert(validPool.length);

    log.info(`Search queries: ${queries.map(q => `"${q.keywords}"`).join(', ')}`);

    // 3. Run the tiered orchestrator (Google SERP, JSearch, RSS/HTTP sources)
    const runStart = Date.now();
    const orchestratorResult = await runOrchestrator(queries, hasPaidProxy);
    const orchestratorDuration = Date.now() - runStart;
    logStructured('info', 'Orchestrator completed', {
        service: 'orchestrator',
        headlessNeeded: orchestratorResult.headlessNeeded,
        durationMs: orchestratorDuration,
    });

    // 4. Run headless Playwright (Cutshort, Foundit, Shine, TimesJobs, Wellfound + optional Indeed/LinkedIn)
    if (orchestratorResult.headlessNeeded) {
        log.info('\n' + '═'.repeat(60));
        log.info('  ACTIVATING TIER 2: HEADLESS BROWSER SCRAPING');
        log.info('  Cutshort + Foundit + Shine + TimesJobs + Wellfound via Playwright');
        log.info('═'.repeat(60));
        await runHeadlessCrawler(validPool, hasPaidProxy);
    } else {
        log.info('[Main] ✓ Sufficient data collected. Headless skipped.');
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
    closeJsonLogger();
    closeFileLogger();
    process.exit(1);
});
