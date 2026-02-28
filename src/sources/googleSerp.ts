/**
 * src/sources/googleSerp.ts
 *
 * TIER 1 — PRIMARY SOURCE: Google Jobs SERP Scraper
 *
 * Scrapes Google's Jobs search results (the "Jobs" tab / structured job cards
 * that appear on google.com/search?q=...&ibp=htl;jobs). This is the most
 * reliable source because:
 *   1. Google aggregates from hundreds of job boards
 *   2. Listings are already deduplicated by Google
 *   3. Structured data (title, company, location, description) is in clean JSON-LD
 *
 * STRATEGY
 * ────────
 * Google Jobs renders job cards via server-side HTML. The structured data is
 * embedded as JSON in script tags or inside `data-` attributes. We use HTTP
 * requests through the Webshare proxy to fetch the raw HTML, then parse it
 * with Cheerio — NO headless browser needed.
 *
 * We rotate User-Agents and add realistic headers to minimise blocking.
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_NAME = 'google_serp';
const MAX_PAGES = 3;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
];

function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── URL Builder ──────────────────────────────────────────────────────────────

function buildGoogleJobsUrl(query: string, location: string, start = 0): string {
    const q = location ? `${query} jobs in ${location}` : `${query} jobs`;
    const params = new URLSearchParams({
        q,
        ibp: 'htl;jobs',
        ...(start > 0 ? { start: String(start) } : {}),
    });
    return `https://www.google.com/search?${params.toString()}`;
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

async function fetchWithProxy(url: string): Promise<string> {
    const rawProxy = process.env.PROXY_URLS?.split(',')[0]?.trim();
    let proxyUrl = rawProxy;

    // Fix: If proxy contains encoded characters like '+', decode them for got-scraping
    if (rawProxy && rawProxy.includes('@')) {
        try {
            const p = new URL(rawProxy);
            const user = decodeURIComponent(p.username);
            const pass = decodeURIComponent(p.password);
            proxyUrl = `${p.protocol}//${user}:${pass}@${p.hostname}${p.port ? `:${p.port}` : ''}`;
        } catch { /* ignore parsing errors */ }
    }

    const headers: Record<string, string> = {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'X-Requested-With': 'XMLHttpRequest',
    };

    if (proxyUrl) {
        try {
            const { gotScraping } = await import('got-scraping');
            const response = await gotScraping({
                url,
                proxyUrl,
                headers,
                timeout: { request: 30_000 },
                retry: { limit: 2 },
            });
            return response.body;
        } catch (err: any) {
            log.warning(`[GoogleSERP] Proxy fetch failed (${proxyUrl.split('@').pop()}): ${err.message}`);
        }
    }

    // Direct fetch fallback
    try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        return await response.text();
    } catch (err: any) {
        throw new Error(`Failed to fetch Google Jobs: ${err.message}`);
    }
}

// ─── HTML Parser ──────────────────────────────────────────────────────────────

function parseGoogleJobsHtml(html: string): RawJobListing[] {
    const jobs: RawJobListing[] = [];
    const $ = cheerio.load(html);

    // Method 1: JSON-LD script tags (Most reliable)
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const content = $(el).html() ?? '';
            if (!content.includes('"JobPosting"')) return;

            const data = JSON.parse(content);
            const items = Array.isArray(data) ? data : (data?.['@graph'] ?? [data]);
            for (const item of items) {
                if (item?.['@type'] === 'JobPosting' && item.title) {
                    jobs.push({
                        title: item.title,
                        company: item.hiringOrganization?.name ?? 'Unknown',
                        location: item.jobLocation?.address?.addressLocality ??
                            item.jobLocation?.name ?? undefined,
                        description: (item.description ?? '').replace(/<[^>]*>/g, ' ').trim(),
                        url: item.url ?? item.directApply ?? '',
                        salary: item.baseSalary?.value?.value ??
                            item.estimatedSalary?.[0]?.value ?? undefined,
                        jobType: item.employmentType ?? undefined,
                        postedDate: item.datePosted ?? undefined,
                        source: SOURCE_NAME,
                    });
                }
            }
        } catch { /* skip */ }
    });

    // Method 2: Modern HTL Job Cards (li items with specific data attributes)
    $('li[data-jds], [data-jdh], article[data-encoded-doc]').each((_, el) => {
        const $el = $(el);

        // Google randomizes classes, but roles and data-tags are usually stable
        const title = $el.find('[role="heading"], div[class*="title"], h2, h3').first().text().trim();
        const infoBlocks = $el.find('div > span, div').map((_, d) => $(d).text().trim()).get();
        const company = infoBlocks[0] || $el.find('[class*="company"]').first().text().trim();
        const location = infoBlocks[1] || $el.find('[class*="location"]').first().text().trim() || undefined;

        // Extract share link or direct link
        let url = $el.attr('data-share-url') ?? $el.find('a[href]').first().attr('href') ?? '';
        if (url && !url.startsWith('http')) url = `https://www.google.com${url}`;

        if (title && title.length > 3 && !jobs.some(j => j.title === title && j.company === company)) {
            jobs.push({
                title,
                company: company || 'Unknown',
                location,
                description: $el.text().trim().slice(0, 2000),
                url,
                source: SOURCE_NAME,
            });
        }
    });

    // Method 3: Flat list fallback
    if (jobs.length === 0) {
        $('[role="listitem"]').each((_, el) => {
            const $item = $(el);
            const title = $item.find('h3, [role="heading"]').first().text().trim();
            if (!title) return;

            const company = $item.find('div').eq(1).text().trim();
            const location = $item.find('div').eq(2).text().trim();

            if (title && !jobs.some(j => j.title === title)) {
                jobs.push({
                    title,
                    company: company || 'Unknown',
                    location: location || undefined,
                    description: $item.text().trim().slice(0, 2000),
                    url: $item.find('a').attr('href') ?? '',
                    source: SOURCE_NAME,
                });
            }
        });
    }

    return jobs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scrapeGoogleJobs(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const allJobs: RawJobListing[] = [];
    const maxResults = query.maxResults ?? 50;

    log.info(`[GoogleSERP] Starting scrape: "${query.keywords}" in "${query.location ?? 'India'}"`);

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = buildGoogleJobsUrl(
                query.keywords,
                query.location ?? 'India',
                page * 10
            );

            log.debug(`[GoogleSERP] Fetching page ${page + 1}/${MAX_PAGES}: ${url}`);
            const html = await fetchWithProxy(url);

            const pageJobs = parseGoogleJobsHtml(html);
            log.info(`[GoogleSERP] Page ${page + 1}: found ${pageJobs.length} jobs`);

            allJobs.push(...pageJobs);

            if (allJobs.length >= maxResults) break;
            if (pageJobs.length === 0) break;

            // Polite delay between pages
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        }

        log.info(`[GoogleSERP] ✓ Complete: ${allJobs.length} total jobs collected`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: allJobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[GoogleSERP] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: allJobs,
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
