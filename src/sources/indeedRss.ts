/**
 * src/sources/indeedRss.ts
 *
 * TIER 3 — TERTIARY SOURCE: Indeed RSS Feed
 *
 * Indeed exposes an RSS 2.0 feed at:
 *   https://www.indeed.com/rss?q=<query>&l=<location>
 *   https://in.indeed.com/rss?q=<query>&l=<location>
 *
 * This is lightweight, fast, and doesn't trigger bot detection.
 * No headless browser required — pure HTTP + XML parsing.
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types.js';

const SOURCE_NAME = 'indeed_rss';

// ─── URL Builder ──────────────────────────────────────────────────────────────

function buildIndeedRssUrl(query: string, location: string): string {
    const domain = 'in.indeed.com';
    const params = new URLSearchParams({
        q: query,
        l: location,
        sort: 'date',
        fromage: '7',   // Jobs posted within last 7 days
    });
    return `https://${domain}/rss?${params.toString()}`;
}

// ─── RSS Parser ───────────────────────────────────────────────────────────────

function parseRssItems(xml: string): RawJobListing[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const jobs: RawJobListing[] = [];

    $('item').each((_, el) => {
        const $item = $(el);
        const title = $item.find('title').text().trim();
        const link = $item.find('link').text().trim() || $item.find('guid').text().trim();
        const description = $item.find('description').text().trim()
            .replace(/<[^>]*>/g, ' ')   // Strip HTML tags
            .replace(/\s+/g, ' ')       // Collapse whitespace
            .trim();
        const pubDate = $item.find('pubDate').text().trim() || undefined;

        // Indeed RSS includes company in the source or author field
        const company = $item.find('source').text().trim() ||
            $item.find('author').text().trim() ||
            'Unknown';

        // Extract location from description (Indeed patterns: "location - description")
        let location: string | undefined;
        const locMatch = description.match(/^(.+?)\s*-\s*/);
        if (locMatch && locMatch[1].length < 60) {
            location = locMatch[1];
        }

        if (title && link) {
            jobs.push({
                title,
                company,
                location,
                description: description.slice(0, 5000),
                url: link,
                postedDate: pubDate,
                source: SOURCE_NAME,
            });
        }
    });

    return jobs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchIndeedRss(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const location = query.location ?? 'India';

    log.info(`[IndeedRSS] Fetching RSS: "${query.keywords}" in "${location}"`);

    try {
        const url = buildIndeedRssUrl(query.keywords, location);
        const proxyUrl = process.env.PROXY_URLS?.split(',')[0]?.trim();

        let xml: string;

        if (proxyUrl) {
            try {
                let safeProxy = proxyUrl;
                if (proxyUrl.includes('@')) {
                    try {
                        const p = new URL(proxyUrl);
                        const user = decodeURIComponent(p.username);
                        const pass = decodeURIComponent(p.password);
                        safeProxy = `${p.protocol}//${user}:${pass}@${p.hostname}${p.port ? `:${p.port}` : ''}`;
                    } catch { /* ignore */ }
                }

                const { gotScraping } = await import('got-scraping');
                const response = await gotScraping({
                    url,
                    proxyUrl: safeProxy,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'application/rss+xml, application/xml, text/xml',
                    },
                    timeout: { request: 15_000 },
                    retry: { limit: 2 },
                });
                xml = response.body;
            } catch {
                // Fallback to direct
                const resp = await fetch(url, {
                    headers: { 'Accept': 'application/rss+xml, application/xml' },
                });
                xml = await resp.text();
            }
        } else {
            const resp = await fetch(url, {
                headers: { 'Accept': 'application/rss+xml, application/xml' },
            });
            xml = await resp.text();
        }

        const jobs = parseRssItems(xml);
        const maxResults = query.maxResults ?? 50;

        log.info(`[IndeedRSS] ✓ Complete: ${jobs.length} jobs from RSS feed`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: jobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[IndeedRSS] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: [],
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
