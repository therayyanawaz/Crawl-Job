/**
 * src/extractors/cutshort.ts
 *
 * Playwright extractor for Cutshort.io
 *
 * CUTSHORT_HUB  → Search results page — enqueues detail URLs + next page
 * CUTSHORT_DETAIL → Individual job page — extracts full job data
 *
 * Cutshort is a startup-focused platform with minimal bot detection.
 * Rate limit: BASE_DELAY_MS = 2000, max concurrency = 2
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import { CutshortSelectors } from '../config/cutshort.js';

const MAX_PAGES = 5;

async function isCutshortBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    return lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha');
}

export async function extractCutshortHub(context: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, enqueueLinks, log } = context;
    log.info(`[Cutshort-Hub] Processing: ${request.url}`);

    if (await isCutshortBlocked(page)) {
        log.warning(`[Cutshort-Hub] BLOCKED: ${request.url}`);
        return;
    }

    await page.waitForSelector(CutshortSelectors.hub.jobCard, { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(1000 + Math.random() * 500);

    const cardCount = await page.locator(CutshortSelectors.hub.jobCard).count().catch(() => 0);
    log.info(`[Cutshort-Hub] Found ${cardCount} job cards`);

    if (cardCount === 0) {
        log.info('[Cutshort-Hub] No cards found — end of results');
        return;
    }

    const enqueued = await enqueueLinks({
        selector: CutshortSelectors.hub.jobLink,
        label: 'CUTSHORT_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[Cutshort-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs`);

    // Pagination
    const currentUrl = new URL(request.url);
    const currentPage = Number(currentUrl.searchParams.get('page') ?? '1');
    if (currentPage < MAX_PAGES) {
        currentUrl.searchParams.set('page', String(currentPage + 1));
        await enqueueLinks({ urls: [currentUrl.toString()], label: 'CUTSHORT_HUB' });
        log.info(`[Cutshort-Hub] Enqueued page ${currentPage + 1}`);
    }
}

export async function extractCutshortDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; experience: string | undefined; jobType: string | undefined;
    source: string; sourceTier: string;
} | null> {
    const { page, request, log } = context;
    log.info(`[Cutshort-Detail] Extracting: ${request.url}`);

    if (await isCutshortBlocked(page)) {
        log.warning(`[Cutshort-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    await page.waitForSelector(CutshortSelectors.detail.title, { timeout: 12_000 }).catch(() => null);

    const title = await page.locator(CutshortSelectors.detail.title).first().innerText().catch(() => '');
    const company = await page.locator(CutshortSelectors.detail.company).first().innerText().catch(() => '');
    const location = await page.locator(CutshortSelectors.detail.location).first().innerText().catch(() => undefined);
    const description = await page.locator(CutshortSelectors.detail.description).first().innerText().catch(() => '');
    const experience = await page.locator(CutshortSelectors.detail.experience).first().innerText().catch(() => undefined);
    const jobType = await page.locator(CutshortSelectors.detail.jobType).first().innerText().catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.trim(),
        location: location?.trim(),
        description: description.trim(),
        experience: experience?.trim(),
        jobType: jobType?.trim(),
        source: 'cutshort',
        sourceTier: 'headless',
    };
}
