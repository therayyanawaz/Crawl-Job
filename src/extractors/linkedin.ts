/**
 * src/extractors/linkedin.ts
 *
 * Handles two distinct page types for LinkedIn public job search:
 *
 *   LINKEDIN_HUB    → /jobs/search/?keywords=...  (public search results)
 *                     Extracts job IDs → builds direct detail URLs → enqueues.
 *                     Does NOT follow the SPA anchor tags (login wall bypass).
 *
 *   LINKEDIN_DETAIL → /jobs/view/<id>/
 *                     Extracts title, company, location, description, seniority.
 *
 * KEY CHALLENGES ON LINKEDIN
 * ───────────────────────────
 * 1. LOGIN WALL BYPASS: LinkedIn shows public results but the <a> tags inside
 *    cards point to the SPA route which triggers a login redirect. We instead:
 *      a) Read the job ID from `data-entity-urn` or extract it from the href.
 *      b) Construct https://linkedin.com/jobs/view/<id>/ directly.
 *      c) Navigate to that URL — it loads the full job without login.
 *    This gives us the full description that the card doesn't contain.
 *
 * 2. DATADOME: LinkedIn uses Datadome fingerprinting in addition to internal
 *    bot scoring. The main.ts pre-navigation hook enforces 8-second delays.
 *    We add extra defences here:
 *      a) A scroll after load (human reading simulation).
 *      b) No rapid element clicks — we extract text only.
 *      c) maxConcurrentPerDomain=1 (set in rateLimits.ts) ensures we never
 *         open two LinkedIn tabs simultaneously.
 *
 * 3. INFINITE SCROLL vs PAGINATION: LinkedIn's public search does NOT truly
 *    infinite-scroll — it paginates with ?start=N. Scrolling to the bottom
 *    in a real browser triggers a fetch for the next batch, but headless
 *    Playwright doesn't need this: the next batch is immediately available
 *    at the next ?start URL. We skip the scroll-to-load approach entirely
 *    and use URL-based pagination — simpler and CPU-efficient.
 *
 * 4. RESULT CAP: LinkedIn shows at most 100 public results (4 pages of 25)
 *    before enforcing login. We cap at MAX_LINKEDIN_PAGES = 4.
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import {
    LinkedInSelectors,
    extractLinkedInJobId,
    buildLinkedInDetailUrl,
} from '../config/linkedin.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max pages per search query (25/page × 4 = 100 results). */
const MAX_LINKEDIN_PAGES = 4;
const LINKEDIN_PAGE_SIZE = 25;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Gentle downward scroll — makes the page interaction look human.
 * Purely JavaScript scrollTo, no GPU dependency.
 */
async function gentleScroll(page: PlaywrightCrawlingContext['page']): Promise<void> {
    await page.evaluate(() => {
        window.scrollTo({ top: 600 + Math.random() * 400, behavior: 'instant' });
    });
    await page.waitForTimeout(600 + Math.random() * 300);
}

/**
 * Detects LinkedIn-specific block signals:
 *   - "Authwall" redirect (URL contains /authwall)
 *   - "unusual activity" overlay
 *   - Empty job list with a login prompt
 */
async function isLinkedInBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const url = page.url();
    const title = await page.title().catch(() => '');

    if (url.includes('/authwall') || url.includes('/login')) return true;

    const lower = title.toLowerCase();
    if (lower.includes('linkedin login') || lower.includes('sign in to linkedin')) return true;

    // Check for the login-wall modal that sometimes appears as an overlay
    const hasLoginWall = await page
        .locator(LinkedInSelectors.hub.loginWall)
        .isVisible()
        .catch(() => false);

    return hasLoginWall;
}

// ─── Hub Extractor ────────────────────────────────────────────────────────────

/**
 * Processes a LinkedIn public search page (LINKEDIN_HUB label).
 *
 * Steps:
 *  1. Block / authwall detection.
 *  2. Wait for job card container.
 *  3. Extract job IDs from card attributes.
 *  4. Build and enqueue direct /jobs/view/<id>/ URLs.
 *  5. If not at cap, enqueue the next paginated page.
 */
export async function extractLinkedInHub(
    context: PlaywrightCrawlingContext
): Promise<void> {
    const { page, request, enqueueLinks, log } = context;

    log.info(`[LinkedIn-Hub] Processing: ${request.url}`);

    // 1. Block detection
    if (await isLinkedInBlocked(page)) {
        log.warning(`[LinkedIn-Hub] Auth wall or block detected. Stopping for: ${request.url}`);
        return;
    }

    // 2. Wait for the card list container
    const containerFound = await page
        .waitForSelector(LinkedInSelectors.hub.jobListContainer, { timeout: 15_000 })
        .catch(() => null);

    if (!containerFound) {
        log.warning(`[LinkedIn-Hub] Card container not found on: ${request.url}`);
        return;
    }

    // Small scroll — triggers any lazy-loaded cards in view
    await gentleScroll(page);

    // 3. Gather all job IDs from the visible cards
    const cardLocator = page.locator(LinkedInSelectors.hub.jobCard);
    const cardCount = await cardLocator.count().catch(() => 0);

    log.info(`[LinkedIn-Hub] Found ${cardCount} job cards.`);

    const detailUrls: string[] = [];

    for (let i = 0; i < cardCount; i++) {
        const card = cardLocator.nth(i);

        // Try data-entity-urn attribute first
        let jobId: string | null = null;
        const urn = await card.getAttribute('data-entity-urn').catch(() => null);
        if (urn) jobId = extractLinkedInJobId(urn);

        // Fallback: extract ID from the <a> href inside the card
        if (!jobId) {
            const href = await card
                .locator(LinkedInSelectors.hub.jobCardLink)
                .first()
                .getAttribute('href')
                .catch(() => null);
            if (href) jobId = extractLinkedInJobId(href);
        }

        if (jobId) {
            detailUrls.push(buildLinkedInDetailUrl(jobId));
        } else {
            // Last resort: try reading href from any /jobs/view/ link in the card
            const fallbackHref = await card
                .locator('a[href*="/jobs/view/"]')
                .first()
                .getAttribute('href')
                .catch(() => null);

            if (fallbackHref) {
                const id = extractLinkedInJobId(fallbackHref);
                if (id) detailUrls.push(buildLinkedInDetailUrl(id));
            }
        }
    }

    // Deduplicate (same job can appear twice in sponsored + organic results)
    const uniqueUrls = [...new Set(detailUrls)];
    log.info(`[LinkedIn-Hub] Enqueuing ${uniqueUrls.length} unique detail URLs.`);

    if (uniqueUrls.length > 0) {
        await enqueueLinks({
            urls: uniqueUrls,
            label: 'LINKEDIN_DETAIL',
        });
    }

    // 4. Pagination: determine current page number from ?start param
    let currentStart = 0;
    try {
        currentStart = Number(new URL(request.url).searchParams.get('start') ?? '0');
    } catch { /* ignore malformed URL */ }

    const currentPage = Math.floor(currentStart / LINKEDIN_PAGE_SIZE) + 1;

    if (currentPage >= MAX_LINKEDIN_PAGES) {
        log.info(`[LinkedIn-Hub] Page cap (${MAX_LINKEDIN_PAGES}) reached.`);
        return;
    }

    // Also stop if the login wall is visible (means no more public results)
    const wallVisible = await page
        .locator(LinkedInSelectors.hub.loginWall)
        .isVisible()
        .catch(() => false);

    if (wallVisible) {
        log.info('[LinkedIn-Hub] Login wall visible — no more public results. Stopping.');
        return;
    }

    // Enqueue next page
    const nextStart = currentStart + LINKEDIN_PAGE_SIZE;
    const nextUrl = new URL(request.url);
    nextUrl.searchParams.set('start', String(nextStart));

    log.info(`[LinkedIn-Hub] Enqueuing next page (start=${nextStart}): ${nextUrl}`);
    await enqueueLinks({
        urls: [nextUrl.toString()],
        label: 'LINKEDIN_HUB',
    });
}

// ─── Detail Extractor ─────────────────────────────────────────────────────────

/**
 * Extracts structured job data from a LinkedIn public detail page.
 *
 * URL pattern: https://www.linkedin.com/jobs/view/<numeric-id>/
 * These pages are publicly accessible WITHOUT login when navigated to directly.
 *
 * Returns structured data or null if blocked / essential fields missing.
 */
export async function extractLinkedInDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; postedDate: string | undefined; jobType: string | undefined;
    seniority: string | undefined; source: string;
} | null> {
    const { page, request, log } = context;

    log.info(`[LinkedIn-Detail] Extracting: ${request.url}`);

    // Block / authwall check
    if (await isLinkedInBlocked(page)) {
        log.warning(`[LinkedIn-Detail] Auth wall detected for: ${request.url}`);
        return null;
    }

    // Wait for title — the most reliable signal the page has rendered
    const titleEl = await page
        .waitForSelector(LinkedInSelectors.detail.title, { timeout: 15_000 })
        .catch(() => null);

    if (!titleEl) {
        log.warning(
            `[LinkedIn-Detail] Title not found on: ${request.url}. ` +
            'Possibly an expired posting or geographic restriction.'
        );
        return null;
    }

    // Small scroll to trigger lazy-loaded description sections
    await gentleScroll(page);

    // Expand "Show more" in description if present
    // LinkedIn truncates descriptions with a "See more" button
    const showMoreBtn = page.locator('button[aria-label="Click to expand description"]').first();
    if (await showMoreBtn.isVisible().catch(() => false)) {
        await showMoreBtn.click().catch(() => null);
        await page.waitForTimeout(600);
    }

    const title = await page
        .locator(LinkedInSelectors.detail.title).first().innerText()
        .catch(() => '');

    const company = await page
        .locator(LinkedInSelectors.detail.company).first().innerText()
        .catch(() => '');

    const location = await page
        .locator(LinkedInSelectors.detail.location).first().innerText()
        .catch(() => undefined);

    const description = await page
        .locator(LinkedInSelectors.detail.description).first().innerText()
        .catch(() => '');

    const postedDate = await page
        .locator(LinkedInSelectors.detail.postedDate).first().innerText()
        .catch(() => undefined);

    const jobType = await page
        .locator(LinkedInSelectors.detail.jobType).first().innerText()
        .catch(() => undefined);

    const seniority = await page
        .locator(LinkedInSelectors.detail.seniority).first().innerText()
        .catch(() => undefined);

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: company.trim(),
        location: location?.trim(),
        description: description.trim(),
        postedDate: postedDate?.trim(),
        jobType: jobType?.trim(),
        seniority: seniority?.trim(),
        source: 'linkedin',
    };
}
