/**
 * src/sources/himalayasRss.ts
 *
 * TIER 0 — ZERO COST SOURCE: Himalayas RSS Feed
 *
 * Fetch public jobs from Himalayas.app via RSS.
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types.js';

const SOURCE_NAME = 'himalayas_rss';

function parseRssItems(xml: string): RawJobListing[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const jobs: RawJobListing[] = [];

    $('item').each((_, el) => {
        const $item = $(el);
        const title = $item.find('title').text().trim();
        const link = $item.find('link').text().trim() || $item.find('guid').text().trim();
        const description = $item.find('description').text().trim();
        const pubDate = $item.find('pubDate').text().trim() || undefined;

        // Himalayas RSS provides company in custom tags or the URL
        let company = 'Unknown';
        let cleanTitle = title;

        // 1. Try custom Himalayas XML tag
        const tagCompany = $item.find('himalayasJobs\\:companyName').text().trim() ||
            $item.find('companyName').text().trim();

        if (tagCompany) {
            company = tagCompany;
        }

        // 2. Try "Role at Company" pattern
        const titleMatch = title.match(/(.+?)\s+at\s+(.+)/i);
        if (titleMatch) {
            cleanTitle = titleMatch[1].trim();
            if (company === 'Unknown') {
                company = titleMatch[2].trim();
            }
        }

        // 3. Fallback: Extract from URL (e.g., /companies/imagineart/jobs/...)
        if (company === 'Unknown') {
            const urlMatch = link.match(/\/companies\/([^\/]+)/);
            if (urlMatch) {
                company = urlMatch[1]
                    .split('-')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');
            }
        }

        if (title && link) {
            jobs.push({
                title: cleanTitle,
                company,
                description: description.slice(0, 5000).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
                url: link,
                postedDate: pubDate,
                source: SOURCE_NAME,
                sourceTier: 'api',
            });
        }
    });

    return jobs;
}

export async function fetchHimalayasRss(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    log.info(`[HimalayasRSS] Fetching global RSS...`);

    try {
        const url = 'https://himalayas.app/jobs/rss';
        const resp = await fetch(url, {
            headers: { 'Accept': 'application/rss+xml, application/xml' },
            signal: AbortSignal.timeout(30_000)
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const xml = await resp.text();
        let jobs = parseRssItems(xml);

        // Filter by keywords if provided (RSS is global so we must filter locally)
        if (query.keywords) {
            const keys = query.keywords.toLowerCase().split(' ');
            jobs = jobs.filter(j =>
                keys.some(k => j.title.toLowerCase().includes(k) || j.description.toLowerCase().includes(k))
            );
        }

        const maxResults = query.maxResults ?? 50;
        log.info(`[HimalayasRSS] ✓ Complete: ${jobs.length} relevant jobs mapped from RSS`);

        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: jobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[HimalayasRSS] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: [],
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
