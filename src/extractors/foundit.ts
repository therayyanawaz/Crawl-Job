/**
 * src/extractors/foundit.ts
 *
 * Playwright extractor for Foundit.in (ex-Monster India)
 *
 * FOUNDIT_HUB    → Search results — enqueues detail URLs + paginated pages
 * FOUNDIT_DETAIL → Individual job — extracts full data
 *
 * Rate limit: BASE_DELAY_MS = 3000, max concurrency = 1
 * Pagination: ?start= increments by 15
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import { FounditSelectors } from '../config/foundit.js';

const MAX_PAGES = 5;
const FOUNDIT_PAGE_SIZE = 15;

async function isFounditBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    return lower.includes('access denied') || lower.includes('robot') || lower.includes('captcha');
}

export async function extractFounditHub(context: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, enqueueLinks, log } = context;
    log.info(`[Foundit-Hub] Processing: ${request.url}`);

    if (await isFounditBlocked(page)) {
        log.warning(`[Foundit-Hub] BLOCKED: ${request.url}`);
        return;
    }

    await page.waitForSelector(FounditSelectors.hub.jobCard, { timeout: 15_000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);

    const cardCount = await page.locator(FounditSelectors.hub.jobCard).count().catch(() => 0);
    log.info(`[Foundit-Hub] Found ${cardCount} job cards`);

    if (cardCount === 0) {
        log.info('[Foundit-Hub] No cards found — end of results');
        return;
    }

    const enqueued = await enqueueLinks({
        selector: FounditSelectors.hub.jobLink,
        label: 'FOUNDIT_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[Foundit-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs`);

    // Pagination via ?start=
    const currentUrl = new URL(request.url);
    const currentStart = Number(currentUrl.searchParams.get('start') ?? '0');
    const currentPage = Math.floor(currentStart / FOUNDIT_PAGE_SIZE) + 1;

    if (currentPage < MAX_PAGES) {
        currentUrl.searchParams.set('start', String(currentStart + FOUNDIT_PAGE_SIZE));
        await enqueueLinks({ urls: [currentUrl.toString()], label: 'FOUNDIT_HUB' });
        log.info(`[Foundit-Hub] Enqueued page ${currentPage + 1} (start=${currentStart + FOUNDIT_PAGE_SIZE})`);
    }
}

export async function extractFounditDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; experience: string | undefined; salary: string | undefined;
    jobType: string | undefined; source: string; sourceTier: string;
} | null> {
    const { page, request, log } = context;
    log.info(`[Foundit-Detail] Extracting: ${request.url}`);

    if (await isFounditBlocked(page)) {
        log.warning(`[Foundit-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    await page.waitForSelector(FounditSelectors.detail.title, { timeout: 12_000 }).catch(() => null);

    const title = await page.locator(FounditSelectors.detail.title).first().innerText().catch(() => '');
    const company = await page.locator(FounditSelectors.detail.company).first().innerText().catch(() => '');
    const location = await page.locator(FounditSelectors.detail.location).first().innerText().catch(() => undefined);
    const description = await page.locator(FounditSelectors.detail.description).first().innerText().catch(() => '');
    const experience = await page.locator(FounditSelectors.detail.experience).first().innerText().catch(() => undefined);
    const salary = await page.locator(FounditSelectors.detail.salary).first().innerText().catch(() => undefined);
    const jobType = await page.locator(FounditSelectors.detail.jobType).first().innerText().catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.trim(),
        location: location?.trim(),
        description: description.trim(),
        experience: experience?.trim(),
        salary: salary?.trim(),
        jobType: jobType?.trim(),
        source: 'foundit',
        sourceTier: 'headless',
    };
}
