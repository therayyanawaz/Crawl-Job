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
import { Selectors } from './config';
import { isDuplicateJob, markJobAsStored } from './utils/dedup';
import { saveJobToDb } from './utils/jobStore';
import type { StorableJob } from './utils/jobStore';

// ── Site-specific extractors
import { extractExampleBoard } from './extractors/exampleBoard';
import { extractIndeedHub, extractIndeedDetail } from './extractors/indeed';
import { extractLinkedInHub, extractLinkedInDetail } from './extractors/linkedin';

export const router = createPlaywrightRouter();

// ─── Shared Zod Schema ────────────────────────────────────────────────────────

const JobSchema = z.object({
    url: z.string().url(),
    title: z.string().min(2),
    company: z.string().default('Unknown Company'),
    description: z.string().min(50),
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
    // 1. Add scrape timestamp + default sourceTier for headless
    const withTimestamp = {
        ...raw,
        scrapedAt: new Date().toISOString(),
        sourceTier: raw.sourceTier ?? 'headless',
        platform: raw.platform ?? raw.source ?? 'unknown',
    };

    // 2. Zod validation
    let clean: JobRecord;
    try {
        clean = JobSchema.parse(withTimestamp);
    } catch (err) {
        log.warning(`[Router] Validation failed: ${err}`);
        return;
    }

    // 3. Dedup check
    const { isDuplicate, reason } = isDuplicateJob(clean);
    if (isDuplicate) {
        log.debug(`[Router] DUPLICATE (${reason}): "${clean.title}" @ "${clean.company}"`);
        return;
    }

    // 4. Persist — write to Crawlee local store AND PostgreSQL (`attack` DB)
    try {
        await pushData(clean);
        markJobAsStored(clean);
        // Save to PostgreSQL (non-blocking)
        saveJobToDb(clean as unknown as StorableJob).catch(() => null);
        log.info(`[Router] Stored [${clean.source ?? 'unknown'}]: "${clean.title}" @ "${clean.company}"`);
    } catch (err) {
        log.error(`[Router] pushData() failed: ${err}`);
    }
}

// TypeScript type alias for the log parameter — avoids importing a private type
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

// ─── Indeed ───────────────────────────────────────────────────────────────────

router.addHandler('INDEED_HUB', async (context) => {
    await extractIndeedHub(context);
});

router.addHandler('INDEED_DETAIL', async (context) => {
    const { log, pushData } = context;
    const data = await extractIndeedDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

router.addHandler('LINKEDIN_HUB', async (context) => {
    await extractLinkedInHub(context);
});

router.addHandler('LINKEDIN_DETAIL', async (context) => {
    const { log, pushData } = context;
    const data = await extractLinkedInDetail(context);
    if (data) await saveJob(data as Record<string, unknown>, pushData, log);
});
