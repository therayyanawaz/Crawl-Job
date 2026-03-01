/**
 * src/routes.ts
 *
 * Central request router for the Crawlee PlaywrightCrawler.
 *
 * ROUTING STRATEGY
 * ─────────────────
 * Crawlee routes requests by the `label` field set at enqueue time.
 * We use domain-scoped label prefixes so every label unambiguously maps
 * to one extractor and one site:
 *
 *   BOARD_HUB        → generic hub (exampleBoard)
 *   JOB_DETAIL       → generic detail (exampleBoard)
 *   INDEED_HUB       → src/extractors/indeed.ts  (hub)
 *   INDEED_DETAIL    → src/extractors/indeed.ts  (detail)
 *   LINKEDIN_HUB     → src/extractors/linkedin.ts (hub)
 *   LINKEDIN_DETAIL  → src/extractors/linkedin.ts (detail)
 *
 * ADDING A NEW SITE
 * ──────────────────
 * 1. Create src/config/<site>.ts  — define selectors and URL helpers.
 * 2. Create src/extractors/<site>.ts — implement extractHub() and extractDetail().
 * 3. Import both here and add two router.addHandler() blocks below.
 * 4. In main.ts, call crawler.addRequests() with your seed URLs and the new labels.
 * That's it — no other files need to change.
 */

import { createPlaywrightRouter } from 'crawlee';
import { z } from 'zod';
import { Selectors } from './config.js';
import { isDuplicateJob, markJobAsStored } from './utils/dedup.js';
import { saveJobToDb } from './utils/jobStore.js';
import type { StorableJob } from './utils/jobStore.js';
import { enqueuePersistenceTask } from './utils/persistenceQueue.js';

// ── Ollama LLM extraction
import {
    extractJobsFromHtml,
    filterFresherOnly,
    normalizeJobRecord,
    toStorableJob,
    isOllamaAvailable,
} from './services/ollamaExtractor.js';
import type { OllamaJobRecord } from './services/ollamaExtractor.js';

// ── Site-specific extractors (selector-based fallback)
import { extractExampleBoard } from './extractors/exampleBoard.js';
import { extractIndeedHub, extractIndeedDetail } from './extractors/indeed.js';
import { extractLinkedInHub, extractLinkedInDetail } from './extractors/linkedin.js';
import { extractCutshortHub, extractCutshortDetail } from './extractors/cutshort.js';
import { extractFounditHub, extractFounditDetail } from './extractors/foundit.js';
import { extractShineHub, extractShineDetail } from './extractors/shine.js';
import { extractTimesJobsHub, extractTimesJobsDetail } from './extractors/timesjobs.js';
import { extractWellfoundHub, extractWellfoundDetail } from './extractors/wellfound.js';

export const router = createPlaywrightRouter();

// ─── Shared Zod Schema ────────────────────────────────────────────────────────

const JobSchema = z.object({
    url: z.string().url(),
    title: z.string().min(2),
    company: z.string().default('Unknown Company'),
    description: z.string().min(10),  // relaxed from 50: some API sources have short descriptions
    location: z.string().optional(),
    postedDate: z.string().optional(),
    jobType: z.string().optional(),
    salary: z.string().optional(),
    seniority: z.string().optional(),
    experience: z.string().optional(),
    source: z.string().optional(),
    platform: z.string().optional(),
    platformJobId: z.string().optional(),
    applyUrl: z.string().optional(),
    sourceTier: z.string().optional(),
    scrapedAt: z.string().datetime(),
});

export type JobRecord = z.infer<typeof JobSchema>;

// ─── Shared Save Helper ───────────────────────────────────────────────────────

async function saveJob(
    raw: Record<string, unknown>,
    pushData: (data: Record<string, unknown>) => Promise<void>,
    log: PlaywrightCrawlingContext_log
): Promise<void> {
    const withTimestamp = {
        ...raw,
        scrapedAt: new Date().toISOString(),
        sourceTier: raw.sourceTier ?? 'headless',
        platform: raw.platform ?? raw.source ?? 'unknown',
    };

    let clean: JobRecord;
    try {
        clean = JobSchema.parse(withTimestamp);
    } catch (err) {
        log.warning(`[Router] Validation failed: ${err}`);
        return;
    }

    const { isDuplicate, reason } = await isDuplicateJob(clean);
    if (isDuplicate) {
        log.debug(`[Router] DUPLICATE (${reason}): "${clean.title}" @ "${clean.company}"`);
        return;
    }

    try {
        await pushData(clean);
        enqueuePersistenceTask(async () => {
            await markJobAsStored(clean);
            await saveJobToDb(clean as unknown as StorableJob);
        });
        log.info(`[Router] Stored [${clean.source ?? 'unknown'}]: "${clean.title}" @ "${clean.company}"`);
    } catch (err) {
        log.error(`[Router] pushData() failed: ${err}`);
    }
}

type PlaywrightCrawlingContext_log = import('crawlee').PlaywrightCrawlingContext['log'];

// ─── Default Handler ──────────────────────────────────────────────────────────

router.addDefaultHandler(async ({ request, log }) => {
    log.warning(`[Router] No handler for label="${request.label}" url=${request.url}`);
});

// ─── Generic / ExampleBoard ───────────────────────────────────────────────────

router.addHandler('BOARD_HUB', async (context) => {
    await extractExampleBoard(context);
});

router.addHandler('JOB_DETAIL', async ({ page, request, log, pushData }) => {
    log.info(`[Router/JOB_DETAIL] Extracting: ${request.url}`);

    await page.waitForSelector(Selectors.exampleBoard.title, { timeout: 5000 }).catch(() => null);

    const title = await page.locator(Selectors.exampleBoard.title).first().innerText().catch(() => '');
    const company = await page.locator(Selectors.exampleBoard.company).first().innerText().catch(() => '');
    const description = await page.locator('.job-description').first().innerText().catch(() => '');
    const location = await page.locator('.job-location').first().innerText().catch(() => undefined);
    const postedDate = await page.locator('.job-posted-date').first().getAttribute('datetime').catch(() => undefined);

    await saveJob(
        { url: request.loadedUrl ?? request.url, title, company, description, location, postedDate, source: 'exampleboard' },
        pushData,
        log
    );
});

// ─── Indeed (disabled by default — ENABLE_INDEED=true to activate) ────────────

router.addHandler('INDEED_HUB', async (context) => {
    await extractIndeedHub(context);
});

router.addHandler('INDEED_DETAIL', async (context) => {
    const { log, pushData } = context;
    const data = await extractIndeedDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── LinkedIn (disabled by default — ENABLE_LINKEDIN=true to activate) ────────

router.addHandler('LINKEDIN_HUB', async (context) => {
    await extractLinkedInHub(context);
});

router.addHandler('LINKEDIN_DETAIL', async (context) => {
    const { log, pushData } = context;
    const data = await extractLinkedInDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── Ollama-powered extraction helper ─────────────────────────────────────────
// Shared by all hub/detail handlers below. Wraps extractJobsFromHtml in
// try/catch so Ollama failure NEVER crashes the crawl.

async function ollamaExtractAndSave(
    page: import('crawlee').PlaywrightCrawlingContext['page'],
    request: import('crawlee').PlaywrightCrawlingContext['request'],
    pushData: (data: Record<string, unknown>) => Promise<void>,
    log: PlaywrightCrawlingContext_log,
    label: string
): Promise<boolean> {
    if (!isOllamaAvailable()) return false;

    const rawHtml = await page.innerHTML('body').catch(() => '');
    if (!rawHtml || rawHtml.length < 100) return false;

    const pageUrl = request.loadedUrl ?? request.url;
    const source = label;

    let jobs: OllamaJobRecord[] = [];
    try {
        jobs = await extractJobsFromHtml(rawHtml, pageUrl, source);
        jobs = filterFresherOnly(jobs);
        log.info(`[OllamaExtractor] ${source} → extracted ${jobs.length} fresher jobs from ${pageUrl}`);
    } catch (err) {
        log.error(`[OllamaExtractor] Failed for ${source}: ${(err as Error).message}`);
        return false;  // fall back to selector-based
    }

    if (jobs.length === 0) return false;

    for (const job of jobs) {
        const normalized = normalizeJobRecord(job, source);
        const storable = toStorableJob(normalized, pageUrl);
        await saveJob(storable, pushData, log);
    }

    return true;  // successfully extracted via Ollama
}

// ─── Cutshort ─────────────────────────────────────────────────────────────────

router.addHandler('CUTSHORT_HUB', async (context) => {
    await extractCutshortHub(context);
});

router.addHandler('CUTSHORT_DETAIL', async (context) => {
    const { page, request, log, pushData } = context;

    // Try Ollama first
    const ollamaOk = await ollamaExtractAndSave(page, request, pushData, log, 'CUTSHORT_DETAIL');
    if (ollamaOk) return;

    // Fallback: selector-based extraction
    const data = await extractCutshortDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── Foundit.in (ex-Monster India) ────────────────────────────────────────────

router.addHandler('FOUNDIT_HUB', async (context) => {
    await extractFounditHub(context);
});

router.addHandler('FOUNDIT_DETAIL', async (context) => {
    const { page, request, log, pushData } = context;

    // Try Ollama first
    const ollamaOk = await ollamaExtractAndSave(page, request, pushData, log, 'FOUNDIT_DETAIL');
    if (ollamaOk) return;

    // Fallback: selector-based extraction
    const data = await extractFounditDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── Shine.com ────────────────────────────────────────────────────────────────

router.addHandler('SHINE_HUB', async (context) => {
    await extractShineHub(context);
});

router.addHandler('SHINE_DETAIL', async (context) => {
    const { page, request, log, pushData } = context;

    // Try Ollama first
    const ollamaOk = await ollamaExtractAndSave(page, request, pushData, log, 'SHINE_DETAIL');
    if (ollamaOk) return;

    // Fallback: selector-based extraction
    const data = await extractShineDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── TimesJobs ────────────────────────────────────────────────────────────────

router.addHandler('TIMESJOBS_HUB', async (context) => {
    await extractTimesJobsHub(context);
});

router.addHandler('TIMESJOBS_DETAIL', async (context) => {
    const { page, request, log, pushData } = context;

    // Try Ollama first
    const ollamaOk = await ollamaExtractAndSave(page, request, pushData, log, 'TIMESJOBS_DETAIL');
    if (ollamaOk) return;

    // Fallback: selector-based extraction
    const data = await extractTimesJobsDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── Wellfound (ex-AngelList) ─────────────────────────────────────────────────

router.addHandler('WELLFOUND_HUB', async (context) => {
    await extractWellfoundHub(context);
});

router.addHandler('WELLFOUND_DETAIL', async (context) => {
    const { page, request, log, pushData } = context;

    // Try Ollama first
    const ollamaOk = await ollamaExtractAndSave(page, request, pushData, log, 'WELLFOUND_DETAIL');
    if (ollamaOk) return;

    // Fallback: selector-based extraction
    const data = await extractWellfoundDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});
