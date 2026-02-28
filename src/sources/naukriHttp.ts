/**
 * src/sources/naukriHttp.ts
 *
 * TIER 3 — TERTIARY SOURCE: Naukri.com (HTTP only, no headless)
 *
 * Naukri renders job listings as server-side HTML (SSR).
 * We fetch the raw HTML via HTTP and parse with Cheerio.
 *
 * URL patterns:
 *   /jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=adv&keyword=<query>&location=<loc>
 *   /jobs-in-india/<query>-jobs (public search pages)
 *
 * Naukri has moderate bot detection but HTTP-only requests with proper
 * headers generally pass through. We use the Webshare proxy for safety.
 */

import { log } from 'crawlee';
import * as cheerio from 'cheerio';
import type { RawJobListing, SearchQuery, SourceResult } from './types';

const SOURCE_NAME = 'naukri';

// ─── URL Builder ──────────────────────────────────────────────────────────────

function buildNaukriUrls(query: string, location: string): string[] {
    const slug = query.toLowerCase().replace(/\s+/g, '-');
    const locSlug = location.toLowerCase().replace(/\s+/g, '-');

    return [
        `https://www.naukri.com/${slug}-jobs-in-${locSlug}`,
        `https://www.naukri.com/${slug}-jobs`,
    ];
}

// ─── Naukri also has an internal API that returns JSON ──────────────────────

async function fetchNaukriApi(query: string, location: string, proxyUrl?: string): Promise<RawJobListing[]> {
    const params = new URLSearchParams({
        noOfResults: '20',
        urlType: 'search_by_keyword',
        searchType: 'adv',
        keyword: query,
        location: location,
        k: query,
        l: location,
        experience: '0',
        sort: 'date',
    });

    const url = `https://www.naukri.com/jobapi/v3/search?${params.toString()}`;
    const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-IN,en;q=0.9',
        'appid': '109',
        'systemid': 'Starter',
        'Referer': 'https://www.naukri.com/',
    };

    try {
        let body: string | undefined;

        // 1. Direct Request (Null tier)
        try {
            const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
            if (resp.ok) body = await resp.text();
            else log.debug(`[Naukri] API direct HTTP ${resp.status}`);
        } catch (e: any) {
            log.debug(`[Naukri] API direct error: ${e.message}`);
        }

        // 2. Proxy Fallback (Webshare Tier 1)
        if (!body && proxyUrl) {
            log.info(`[Naukri] API direct failed, falling back to proxy...`);

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
                headers,
                timeout: { request: 15_000 },
                retry: { limit: 1 },
            });
            body = response.body;
        }

        if (!body) throw new Error('API fetch failed directly and via proxy');

        const data = JSON.parse(body);
        const jobList = data?.jobDetails ?? data?.data ?? [];

        return jobList.map((job: any): RawJobListing => ({
            title: job.title ?? job.designation ?? '',
            company: job.companyName ?? job.company ?? 'Unknown',
            location: job.placeholders?.find((p: any) => p.type === 'location')?.label ??
                job.jobLocation ?? job.location ?? undefined,
            description: (job.jobDescription ?? job.snippet ?? job.title ?? '').slice(0, 5000),
            url: job.jdURL?.startsWith('http') ? job.jdURL :
                `https://www.naukri.com${job.jdURL ?? `/job-listings-${job.jobId}`}`,
            salary: job.placeholders?.find((p: any) => p.type === 'salary')?.label ??
                job.salary ?? undefined,
            jobType: job.placeholders?.find((p: any) => p.type === 'experience')?.label ??
                job.experienceText ?? undefined,
            postedDate: job.footerPlaceholderLabel ?? job.createdDate ?? undefined,
            source: SOURCE_NAME,
        })).filter((j: RawJobListing) => j.title);

    } catch (err: any) {
        log.debug(`[Naukri] API fetch failed: ${err.message}`);
        return [];
    }
}

// ─── HTML Fallback Parser ─────────────────────────────────────────────────────

function parseNaukriHtml(html: string): RawJobListing[] {
    const $ = cheerio.load(html);
    const jobs: RawJobListing[] = [];

    // Naukri job cards
    $('[class*="jobTuple"], [class*="srp-jobtuple"], article[class*="jobCard"]').each((_, el) => {
        const $card = $(el);

        const title = $card.find('[class*="title"] a, [class*="designation"] a, .row1 a').first().text().trim();
        const company = $card.find('[class*="companyInfo"] a, [class*="company"], .subTitle').first().text().trim();
        const location = $card.find('[class*="location"], .locWdth, [class*="loc"] span').first().text().trim() || undefined;
        const experience = $card.find('[class*="experience"], .expwdth').first().text().trim() || undefined;
        const salary = $card.find('[class*="salary"], .salwdth').first().text().trim() || undefined;
        const description = $card.find('[class*="job-description"], .job-desc, .ellipsis').first().text().trim();

        const href = $card.find('a[href*="naukri.com"]').first().attr('href') ??
            $card.find('[class*="title"] a').first().attr('href') ?? '';
        const url = href.startsWith('http') ? href : `https://www.naukri.com${href}`;

        if (title) {
            jobs.push({
                title,
                company: company || 'Unknown',
                location,
                description: description || `${title} at ${company}`,
                url,
                salary,
                jobType: experience,
                source: SOURCE_NAME,
            });
        }
    });

    // Fallback: embedded JSON
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html() ?? '');
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                if (item?.['@type'] === 'JobPosting' && item.title &&
                    !jobs.some(j => j.title === item.title)) {
                    jobs.push({
                        title: item.title,
                        company: item.hiringOrganization?.name ?? 'Unknown',
                        location: item.jobLocation?.address?.addressLocality ?? undefined,
                        description: (item.description ?? '').replace(/<[^>]+>/g, ' ').trim().slice(0, 5000),
                        url: item.url ?? '',
                        salary: item.baseSalary?.value?.value ?? undefined,
                        jobType: item.employmentType ?? undefined,
                        postedDate: item.datePosted ?? undefined,
                        source: SOURCE_NAME,
                    });
                }
            }
        } catch { /* skip */ }
    });

    return jobs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchNaukriJobs(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const allJobs: RawJobListing[] = [];
    const location = query.location ?? 'India';
    const proxyUrl = process.env.PROXY_URLS?.split(',')[0]?.trim();

    log.info(`[Naukri] Starting HTTP scrape: "${query.keywords}" in "${location}"`);

    try {
        // Try API first (faster, cleaner data)
        const apiJobs = await fetchNaukriApi(query.keywords, location, proxyUrl);
        if (apiJobs.length > 0) {
            allJobs.push(...apiJobs);
            log.info(`[Naukri] API returned ${apiJobs.length} jobs`);
        }

        // If API didn't return enough, try HTML scraping
        if (allJobs.length < 10) {
            const urls = buildNaukriUrls(query.keywords, location);
            for (const url of urls) {
                try {
                    let html: string | undefined;

                    // 1. Direct Request (Null Tier)
                    try {
                        const resp = await fetch(url, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0',
                                'Accept': 'text/html',
                                'Accept-Language': 'en-IN,en;q=0.9',
                            },
                            signal: AbortSignal.timeout(15_000),
                        });
                        if (resp.ok) html = await resp.text();
                        else log.debug(`[Naukri] HTML direct HTTP ${resp.status} on ${url}`);
                    } catch (e: any) {
                        log.debug(`[Naukri] HTML direct error: ${e.message}`);
                    }

                    // 2. Proxy Fallback
                    if (!html && proxyUrl) {
                        log.info(`[Naukri] HTML direct failed, falling back to proxy...`);

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
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                                'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
                                'Referer': 'https://www.google.com/',
                            },
                            timeout: { request: 20_000 },
                            retry: { limit: 1 },
                        });
                        html = response.body;
                    }

                    if (!html) throw new Error('Failed to fetch HTML directly and via proxy');

                    const pageJobs = parseNaukriHtml(html);
                    for (const job of pageJobs) {
                        if (!allJobs.some(j => j.title === job.title && j.company === job.company)) {
                            allJobs.push(job);
                        }
                    }
                    log.info(`[Naukri] HTML ${url}: found ${pageJobs.length} jobs`);

                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                } catch (err: any) {
                    log.warning(`[Naukri] Failed HTML on ${url}: ${err.message}`);
                }
            }
        }

        const maxResults = query.maxResults ?? 50;
        log.info(`[Naukri] ✓ Complete: ${allJobs.length} jobs collected`);

        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: allJobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };
    } catch (err: any) {
        log.error(`[Naukri] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: allJobs,
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
