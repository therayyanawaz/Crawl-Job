/**
 * src/extractors/wellfound.ts
 *
 * Playwright extractor for Wellfound (ex-AngelList)
 */

import type { PlaywrightCrawlingContext } from 'crawlee';
import { WellfoundSelectors } from '../config/wellfound.js';

const MAX_PAGES = 3; // Keep low for Wellfound

async function isWellfoundBlocked(page: PlaywrightCrawlingContext['page']): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const lower = title.toLowerCase();
    // Wellfound blocks are usually a CloudFlare Turnstile page
    return lower.includes('just a moment') || lower.includes('cloudflare') || lower.includes('robot');
}

export async function extractWellfoundHub(context: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, enqueueLinks, log } = context;
    log.info(`[Wellfound-Hub] Processing: ${request.url}`);

    if (await isWellfoundBlocked(page)) {
        log.warning(`[Wellfound-Hub] BLOCKED: ${request.url}`);
        return;
    }

    // Wait for jobs to render (React SPA)
    await page.waitForTimeout(3000 + Math.random() * 2000);
    // Wellfound has obfuscated CSS classes. Broad selector:
    const cards = page.locator('a[href*="/jobs/"]');
    const cardCount = await cards.count().catch(() => 0);
    log.info(`[Wellfound-Hub] Found ~${cardCount} job links`);

    if (cardCount === 0) {
        log.info('[Wellfound-Hub] No cards found — end of results');
        return;
    }

    const enqueued = await enqueueLinks({
        // Extract href from any link that contains /jobs/
        selector: 'a[href*="/jobs/"]',
        label: 'WELLFOUND_DETAIL',
        strategy: 'same-hostname',
    });
    log.info(`[Wellfound-Hub] Enqueued ${enqueued.processedRequests.length} detail URLs`);

    // Pagination for Wellfound is usually via an API or internal state on the SPA.
    // If there is an obvious next button, we would click it, but doing that in a 
    // distributed crawler isn't ideal. Usually you construct the URL. 
    // We'll rely on the initial load for now, given their bot defenses.
}

export async function extractWellfoundDetail(
    context: PlaywrightCrawlingContext
): Promise<{
    url: string; title: string; company: string; location: string | undefined;
    description: string; source: string; sourceTier: string;
} | null> {
    const { page, request, log } = context;
    log.info(`[Wellfound-Detail] Extracting: ${request.url}`);

    if (await isWellfoundBlocked(page)) {
        log.warning(`[Wellfound-Detail] BLOCKED: ${request.url}`);
        return null;
    }

    await page.waitForTimeout(2000 + Math.random() * 1000); // SPA delay

    // We try generic textual grab if selectors fail due to obfuscation
    const title = await page.locator('h1, h2').first().innerText().catch(() => '');
    const company = await page.title().catch(() => ''); // Title often has "Role at Company"
    const description = await page.locator('main, [class*="description"], article').first().innerText().catch(() => '');

    let cleanCompany = company;
    const match = company.match(/at\s+(.+?)(?:\||$)/i);
    if (match) cleanCompany = match[1].trim();

    return {
        url: request.loadedUrl ?? request.url,
        title: title.trim(),
        company: cleanCompany,
        location: undefined, // Usually embedded in header tags
        description: description.trim(),
        source: 'wellfound',
        sourceTier: 'headless',
    };
}
