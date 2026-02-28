/**
 * src/sources/internshalaHttp.ts
 *
 * TIER 3 — TERTIARY SOURCE: Internshala (HTTP only, no headless)
 *
 * Internshala renders internship listings as server-side HTML.
 * We fetch the raw HTML via HTTP request and parse with Cheerio.
 * This is the lightest-weight source — Internshala has minimal bot detection.
 *
 * URL patterns:
 *   /internships/computer-science-internship
 *   /internships/work-from-home-software-development-internships
 *   /internships/keywords-<query>
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types';

const SOURCE_NAME = 'internshala';

// ─── URL Builder ──────────────────────────────────────────────────────────────

function buildInternshalaUrls(query: string): string[] {
    const slug = query.toLowerCase().replace(/\s+/g, '-');
    return [
        `https://internshala.com/internships/keywords-${slug}`,
        `https://internshala.com/internships/${slug}-internship`,
    ];
}

// ─── HTML Parser ──────────────────────────────────────────────────────────────

function parseInternshalaHtml(html: string): RawJobListing[] {
    const $ = cheerio.load(html);
    const jobs: RawJobListing[] = [];

    // Internshala internship cards
    $('.individual_internship, .internship_meta, [class*="internship-card"]').each((_, el) => {
        const $card = $(el);

        const title = $card.find('.heading_4_5 a, h3 a, .job-internship-name a, .profile a').first().text().trim();
        const company = $card.find('.heading_6, .company_name a, .company_name, .link_display_like_text').first().text().trim();
        const location = $card.find('.location_link a, #location_names a, .locations a').first().text().trim() || undefined;

        const stipend = $card.find('.stipend, [class*="stipend"]').first().text().trim() || undefined;
        const duration = $card.find('.item_body:contains("Months"), .other_detail_item_row .item_body').first().text().trim() || undefined;

        const href = $card.find('.heading_4_5 a, h3 a, .profile a, a[href*="/internship/"]').first().attr('href') ?? '';
        const url = href.startsWith('http') ? href : `https://internshala.com${href}`;

        // Build description from available text
        const descParts = [$card.find('.internship_other_details, .other_detail_item').text().trim()];
        if (duration) descParts.push(`Duration: ${duration}`);
        const description = descParts.join(' | ').trim();

        if (title && url.includes('/internship/')) {
            jobs.push({
                title,
                company: company || 'Unknown',
                location,
                description: description || `Internship: ${title} at ${company}`,
                url,
                salary: stipend,
                jobType: 'Internship',
                source: SOURCE_NAME,
            });
        }
    });

    // Fallback: check for JSON data embedded in script
    $('script').each((_, el) => {
        const text = $(el).html() ?? '';
        if (text.includes('internship_list_data') || text.includes('"title"')) {
            try {
                const match = text.match(/internship_list_data\s*=\s*(\[[\s\S]*?\]);/);
                if (match) {
                    const data = JSON.parse(match[1]);
                    for (const item of data) {
                        if (item.title && !jobs.some(j => j.title === item.title)) {
                            jobs.push({
                                title: item.title,
                                company: item.company_name ?? 'Unknown',
                                location: item.location_names?.join(', ') ?? undefined,
                                description: item.title,
                                url: `https://internshala.com/internship/detail/${item.id}`,
                                salary: item.stipend?.salary ?? undefined,
                                jobType: 'Internship',
                                source: SOURCE_NAME,
                            });
                        }
                    }
                }
            } catch { /* not parseable */ }
        }
    });

    return jobs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchInternshalaJobs(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const allJobs: RawJobListing[] = [];

    log.info(`[Internshala] Starting HTTP scrape: "${query.keywords}"`);

    try {
        const urls = buildInternshalaUrls(query.keywords);
        const proxyUrl = process.env.PROXY_URLS?.split(',')[0]?.trim();

        for (const url of urls) {
            try {
                let html: string | undefined;

                // 1. Direct request (Null Tier)
                try {
                    const resp = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'en-IN,en;q=0.9',
                        },
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (resp.ok) {
                        html = await resp.text();
                    } else {
                        log.debug(`[Internshala] Direct HTTP ${resp.status} on ${url}`);
                    }
                } catch (err: any) {
                    log.debug(`[Internshala] Direct fetch error: ${err.message}`);
                }

                // 2. Proxy fallback (Webshare Tier 1)
                if (!html && proxyUrl) {
                    log.info(`[Internshala] Direct request failed, falling back to proxy...`);

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
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'en-IN,en;q=0.9',
                        },
                        timeout: { request: 20_000 },
                        retry: { limit: 1 },
                    });
                    html = response.body;
                }

                if (!html) throw new Error('Failed to fetch page data');

                const pageJobs = parseInternshalaHtml(html);
                log.info(`[Internshala] ${url}: found ${pageJobs.length} listings`);

                for (const job of pageJobs) {
                    if (!allJobs.some(j => j.title === job.title && j.company === job.company)) {
                        allJobs.push(job);
                    }
                }

                // Polite delay between URLs
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));

            } catch (err: any) {
                log.warning(`[Internshala] Failed on ${url}: ${err.message}`);
            }
        }

        const maxResults = query.maxResults ?? 50;
        log.info(`[Internshala] ✓ Complete: ${allJobs.length} internships collected`);

        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: allJobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[Internshala] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: allJobs,
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
