/**
 * src/sources/jobicyRss.ts
 *
 * TIER 0 — ZERO COST SOURCE: Jobicy RSS
 *
 * Jobicy provides remote and tech jobs in an RSS feed.
 * We fetch it via pure HTTP/cheerio, replacing JSearch API.
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types.js';

const SOURCE_NAME = 'jobicy_rss';

export async function fetchJobicyRss(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    log.info(`[JobicyRSS] Fetching global RSS...`);

    try {
        const url = 'https://jobicy.com/feed/job_feed';
        const resp = await fetch(url, {
            headers: { 'Accept': 'application/rss+xml, application/xml' },
            signal: AbortSignal.timeout(30_000)
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const xml = await resp.text();
        const $ = cheerio.load(xml, { xmlMode: true });

        let jobs: RawJobListing[] = [];

        $('item').each((_, el) => {
            const $item = $(el);
            const title = $item.find('title').text().trim();
            const link = $item.find('link').text().trim() || $item.find('guid').text().trim();
            const description = $item.find('description').text().trim().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            const pubDate = $item.find('pubDate').text().trim() || undefined;

            let company = 'Unknown';
            const companyTag = $item.find('dc\\:creator').text().trim()
                || $item.find('company').text().trim();
            if (companyTag) {
                company = companyTag;
            } else {
                const titleParts = title.split(' at ');
                if (titleParts.length > 1) {
                    company = titleParts[titleParts.length - 1].trim();
                }
            }

            if (title && link) {
                jobs.push({
                    title,
                    company,
                    description: description.slice(0, 5000),
                    url: link,
                    postedDate: pubDate,
                    source: SOURCE_NAME,
                    sourceTier: 'api',
                });
            }
        });

        if (query.keywords) {
            const keys = query.keywords.toLowerCase().split(' ');
            jobs = jobs.filter(j =>
                keys.some(k => j.title.toLowerCase().includes(k) || j.description.toLowerCase().includes(k))
            );
        }

        const maxResults = query.maxResults ?? 50;
        log.info(`[JobicyRSS] ✓ Complete: ${jobs.length} relevant jobs matched`);

        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: jobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[JobicyRSS] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: [],
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
