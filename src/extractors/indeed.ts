/**
 * src/extractors/indeed.ts
 *
 * Handles two distinct page types for Indeed:
 *
 *   INDEED_HUB    → /jobs?q=...  (search results list)
 *                   Enqueues job-detail URLs + next page.
 *
 *   INDEED_DETAIL → /viewjob?jk=...  or  /rc/clk?jk=...
 *                   Extracts title, company, location, description, salary.
 *
 * KEY CHALLENGES ON INDEED
 * ─────────────────────────
 * 1. DYNAMIC LOADING: The job card list is server-side rendered (visible in raw
 *    HTML), but Indeed also loads additional ad-sponsored results via XHR after
 *    the initial paint. We waitForSelector() on the container, then use
 *    page.waitForLoadState('networkidle') to capture the XHR additions.
 *    On a slow proxy this can take 8-15 seconds — do not reduce the timeout.
 *
 * 2. AKAMAI BOT MANAGER: Indeed uses Akamai on the US domain and a lighter
 *    Perimeter X implementation on in.indeed.com. The pre-navigation hook in
 *    main.ts already applies domain-specific delays. We add extra stealth by:
 *      a) Randomising scroll position after load (looks like a human reading).
 *      b) Moving the mouse before clicking (if we ever click anything).
 *    Never navigate faster than the rate limits in src/config/rateLimits.ts.
 *
 * 3. PAGINATION: Indeed uses query param ?start=0, ?start=10, ?start=20 …
 *    We compute the next Start offset ourselves (avoid relying on the Next button
 *    being present — it sometimes disappears during A/B tests).
 *    We cap at MAX_INDEED_PAGES to respect robots.txt crawl rate guidance.
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import {
    IndeedSelectors,
    buildIndeedSearchUrl,
    getIndeedStartOffset,
} from '../config/indeed';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max pages to crawl per search query. 10 pages × 10 results = 100 jobs/query. */
const MAX_INDEED_PAGES = 10;

/** Results per page (Indeed's fixed page size). */
const INDEED_PAGE_SIZE = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulates a human-like scroll to reveal lazy-loaded content.
 * Uses JavaScript scrollBy — no GPU, no animation frames, CPU-safe.
 */
async function humanScroll(page: PlaywrightCrawlingContext['page']): Promise<void> {
    await page.evaluate(() => {
        // Cast to HTMLElement to access scrollHeight safely
        const body = document.body as HTMLElement;
        const totalHeight = body.scrollHeight;
        // Scroll to a random point between 30% and 80% of the page
        const target = totalHeight * (0.3 + Math.random() * 0.5);
        window.scrollTo({ top: target, behavior: 'instant' });
    });
    // Brief pause so lazy images/XHR triggered by scroll can fire
    await page.waitForTimeout(800 + Math.random() * 400);
}

/**
 * Checks if Indeed has returned a CAPTCHA or "unusual traffic" block page.
 * Returns true if we should abort this page and retire the session.
 */
async function isIndeedBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    return (
        lower.includes('captcha') ||
        lower.includes('unusual traffic') ||
        lower.includes('blocked') ||
        lower.includes('access denied')
    );
}

// ─── Hub Extractor ────────────────────────────────────────────────────────────

/**
 * Processes an Indeed search-results page (INDEED_HUB label).
 *
 * Steps:
 *  1. Confirm page is not blocked.
 *  2. Wait for the job list container.
 *  3. Wait for network idle (catches XHR-loaded sponsored cards).
 *  4. Simulate scroll (triggers lazy-loaded images, looks human).
 *  5. Enqueue all job-detail link hrefs.
 *  6. Enqueue the next search-results page if we haven't hit the cap.
 */
export async function extractIndeedHub(
    context: PlaywrightCrawlingContext
): Promise<void> {
    const { page, request, enqueueLinks, log } = context;

    log.info(`[Indeed-Hub] Processing: ${request.url}`);

    // 1. Block detection
    if (await isIndeedBlocked(page)) {
        log.warning(`[Indeed-Hub] BLOCKED page detected. Skipping: ${request.url}`);
        return;
    }

    // 2. Wait for job list container (up to 15 s — slow proxies need time)
    const containerVisible = await page
        .waitForSelector(IndeedSelectors.hub.jobListContainer, { timeout: 15_000 })
        .catch(() => null);

    if (!containerVisible) {
        log.warning(
            `[Indeed-Hub] Job list container not found on: ${request.url}. ` +
            'Possible layout change or empty results page.'
        );
        return;
    }

    // 3. Wait for network to settle (XHR-loaded sponsored slots finish loading)
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);

    // 4. Human-like scroll
    await humanScroll(page);

    // 5. Count visible cards (for logging)
    const cardCount = await page.locator(IndeedSelectors.hub.jobCard).count().catch(() => 0);
    log.info(`[Indeed-Hub] Found ${cardCount} job cards.`);

    // 6. Enqueue job-detail links
    //    strategy: 'same-hostname' prevents us from following Indeed's external redirects
    const enqueued = await enqueueLinks({
        selector: IndeedSelectors.hub.jobLink,
        label: 'INDEED_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[Indeed-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs.`);

    // 7. Pagination — compute next ?start offset
    const currentStart = getIndeedStartOffset(request.url);
    const currentPage = Math.floor(currentStart / INDEED_PAGE_SIZE) + 1;

    if (currentPage >= MAX_INDEED_PAGES) {
        log.info(`[Indeed-Hub] Page cap (${MAX_INDEED_PAGES}) reached. Stopping pagination.`);
        return;
    }

    // Build next URL by incrementing start offset
    const nextStart = currentStart + INDEED_PAGE_SIZE;
    const currentUrl = new URL(request.url);
    currentUrl.searchParams.set('start', String(nextStart));
    const nextUrl = currentUrl.toString();

    log.info(`[Indeed-Hub] Enqueueing next page (start=${nextStart}): ${nextUrl}`);
    await enqueueLinks({
        urls: [nextUrl],
        label: 'INDEED_HUB',
    });
}

// ─── Detail Extractor ─────────────────────────────────────────────────────────

/**
 * Extracts structured job data from an Indeed job-detail page (INDEED_DETAIL).
 *
 * Returns a plain object ready for Zod validation in routes.ts.
 * Returns null if the page is blocked or the required fields cannot be found.
 */
export async function extractIndeedDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; postedDate: string | undefined; jobType: string | undefined;
    salary: string | undefined; source: string;
} | null> {
    const { page, request, log } = context;

    log.info(`[Indeed-Detail] Extracting: ${request.url}`);

    // Block check
    if (await isIndeedBlocked(page)) {
        log.warning(`[Indeed-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    // Wait for title to confirm the page fully rendered
    const titleEl = await page
        .waitForSelector(IndeedSelectors.detail.title, { timeout: 12_000 })
        .catch(() => null);

    if (!titleEl) {
        log.warning(
            `[Indeed-Detail] Title selector not found on: ${request.url}. ` +
            'May be a redirect to login or an expired posting.'
        );
        return null;
    }

    // Extract all fields — each wrapped in .catch() so one missing field
    // does not abort the entire extraction.
    const title = await page
        .locator(IndeedSelectors.detail.title).first().innerText()
        .catch(() => '');

    const company = await page
        .locator(IndeedSelectors.detail.company).first().innerText()
        .catch(() => '');

    const location = await page
        .locator(IndeedSelectors.detail.location).first().innerText()
        .catch(() => undefined);

    // Description: "show more" button may exist — click it to expand
    const showMoreBtn = page.locator('button[aria-label="Show more, visually"]').first();
    if (await showMoreBtn.isVisible().catch(() => false)) {
        await showMoreBtn.click().catch(() => null);
        await page.waitForTimeout(500);
    }

    const description = await page
        .locator(IndeedSelectors.detail.description).first().innerText()
        .catch(() => '');

    const postedDate = await page
        .locator(IndeedSelectors.detail.postedDate).first().innerText()
        .catch(() => undefined);

    const salary = await page
        .locator(IndeedSelectors.detail.salary).first().innerText()
        .catch(() => undefined);

    const jobType = await page
        .locator(IndeedSelectors.detail.jobType).first().innerText()
        .catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.trim(),
        location: location?.trim(),
        description: description.trim(),
        postedDate: postedDate?.trim(),
        jobType: jobType?.trim(),
        salary: salary?.trim(),
        source: 'indeed',
    };
}
