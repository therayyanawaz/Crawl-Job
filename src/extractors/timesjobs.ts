/**
 * src/extractors/timesjobs.ts
 *
 * Playwright extractor for TimesJobs
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import { TimesJobsSelectors } from '../config/timesjobs.js';

const MAX_PAGES = 5;

async function isTimesJobsBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    return lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha');
}

export async function extractTimesJobsHub(context: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, enqueueLinks, log } = context;
    log.info(`[TimesJobs-Hub] Processing: ${request.url}`);

    if (await isTimesJobsBlocked(page)) {
        log.warning(`[TimesJobs-Hub] BLOCKED: ${request.url}`);
        return;
    }

    await page.waitForSelector(TimesJobsSelectors.hub.jobCard, { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(1000 + Math.random() * 500);

    const cardCount = await page.locator(TimesJobsSelectors.hub.jobCard).count().catch(() => 0);
    log.info(`[TimesJobs-Hub] Found ${cardCount} job cards`);

    if (cardCount === 0) {
        log.info('[TimesJobs-Hub] No cards found — end of results');
        return;
    }

    const enqueued = await enqueueLinks({
        selector: TimesJobsSelectors.hub.jobLink,
        label: 'TIMESJOBS_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[TimesJobs-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs`);

    // Pagination via query params (sequence)
    const currentUrl = new URL(request.url);
    const currentPage = Number(currentUrl.searchParams.get('sequence') ?? '1');
    if (currentPage < MAX_PAGES) {
        currentUrl.searchParams.set('sequence', String(currentPage + 1));
        await enqueueLinks({ urls: [currentUrl.toString()], label: 'TIMESJOBS_HUB' });
        log.info(`[TimesJobs-Hub] Enqueued sequence ${currentPage + 1}`);
    }
}

export async function extractTimesJobsDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; experience: string | undefined;
    source: string; sourceTier: string;
} | null> {
    const { page, request, log } = context;
    log.info(`[TimesJobs-Detail] Extracting: ${request.url}`);

    if (await isTimesJobsBlocked(page)) {
        log.warning(`[TimesJobs-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    await page.waitForSelector(TimesJobsSelectors.detail.title, { timeout: 12_000 }).catch(() => null);

    const title = await page.locator(TimesJobsSelectors.detail.title).first().innerText().catch(() => '');
    const company = await page.locator(TimesJobsSelectors.detail.company).first().innerText().catch(() => '');
    const location = await page.locator(TimesJobsSelectors.detail.location).first().innerText().catch(() => undefined);
    const description = await page.locator(TimesJobsSelectors.detail.description).first().innerText().catch(() => '');
    const experience = await page.locator(TimesJobsSelectors.detail.experience).first().innerText().catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.replace(/<[^>]*>?/gm, '').trim(), // Clean up potential span inside h2
        location: location?.trim(),
        description: description.trim(),
        experience: experience?.trim(),
        source: 'timesjobs',
        sourceTier: 'headless',
    };
}
