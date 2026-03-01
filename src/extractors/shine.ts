/**
 * src/extractors/shine.ts
 *
 * Playwright extractor for Shine.com
 *
 * SHINE_HUB    → Search results — enqueues detail URLs + /page-N/ pagination
 * SHINE_DETAIL → Individual job — extracts full data
 *
 * Shine is server-rendered with minimal bot detection.
 * Rate limit: BASE_DELAY_MS = 2500, max concurrency = 2
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import { ShineSelectors } from '../config/shine.js';

const MAX_PAGES = 5;

async function isShineBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    return lower.includes('access denied') || lower.includes('blocked') || lower.includes('robot');
}

export async function extractShineHub(context: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, enqueueLinks, log } = context;
    log.info(`[Shine-Hub] Processing: ${request.url}`);

    if (await isShineBlocked(page)) {
        log.warning(`[Shine-Hub] BLOCKED: ${request.url}`);
        return;
    }

    await page.waitForSelector(ShineSelectors.hub.jobCard, { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(800 + Math.random() * 400);

    const cardCount = await page.locator(ShineSelectors.hub.jobCard).count().catch(() => 0);
    log.info(`[Shine-Hub] Found ${cardCount} job cards`);

    if (cardCount === 0) {
        log.info('[Shine-Hub] No cards found — end of results');
        return;
    }

    const enqueued = await enqueueLinks({
        selector: ShineSelectors.hub.jobLink,
        label: 'SHINE_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[Shine-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs`);

    // Pagination via /page-N/ path pattern
    const urlStr = request.url;
    const pageMatch = urlStr.match(/\/page-(\d+)\//);
    const currentPage = pageMatch ? Number(pageMatch[1]) : 1;

    if (currentPage < MAX_PAGES) {
        const nextPage = currentPage + 1;
        let nextUrl: string;
        if (pageMatch) {
            nextUrl = urlStr.replace(/\/page-\d+\//, `/page-${nextPage}/`);
        } else {
            // Insert /page-N/ before the query string
            const parsed = new URL(urlStr);
            const pathWithPage = parsed.pathname.replace(/\/?$/, `/page-${nextPage}/`);
            parsed.pathname = pathWithPage;
            nextUrl = parsed.toString();
        }
        await enqueueLinks({ urls: [nextUrl], label: 'SHINE_HUB' });
        log.info(`[Shine-Hub] Enqueued page ${nextPage}`);
    }
}

export async function extractShineDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; experience: string | undefined; salary: string | undefined;
    jobType: string | undefined; source: string; sourceTier: string;
} | null> {
    const { page, request, log } = context;
    log.info(`[Shine-Detail] Extracting: ${request.url}`);

    if (await isShineBlocked(page)) {
        log.warning(`[Shine-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    await page.waitForSelector(ShineSelectors.detail.title, { timeout: 12_000 }).catch(() => null);

    const title = await page.locator(ShineSelectors.detail.title).first().innerText().catch(() => '');
    const company = await page.locator(ShineSelectors.detail.company).first().innerText().catch(() => '');
    const location = await page.locator(ShineSelectors.detail.location).first().innerText().catch(() => undefined);
    const description = await page.locator(ShineSelectors.detail.description).first().innerText().catch(() => '');
    const experience = await page.locator(ShineSelectors.detail.experience).first().innerText().catch(() => undefined);
    const salary = await page.locator(ShineSelectors.detail.salary).first().innerText().catch(() => undefined);
    const jobType = await page.locator(ShineSelectors.detail.jobType).first().innerText().catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.trim(),
        location: location?.trim(),
        description: description.trim(),
        experience: experience?.trim(),
        salary: salary?.trim(),
        jobType: jobType?.trim(),
        source: 'shine',
        sourceTier: 'headless',
    };
}
