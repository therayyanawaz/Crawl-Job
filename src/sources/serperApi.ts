/**
 * src/sources/serperApi.ts
 *
 * TIER 1 — PRIMARY SOURCE: Serper.dev API
 *
 * Replaces direct Google scraping by using Serper.dev's structured SERP API.
 */

import { log } from 'crawlee';
import type { RawJobListing, SearchQuery, SourceResult } from './types.js';

const SOURCE_NAME = 'serper_api';
const MAX_RESULTS_FALLBACK = 50;

export async function fetchSerperJobs(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const allJobs: RawJobListing[] = [];
    const maxResults = query.maxResults ?? MAX_RESULTS_FALLBACK;
    const location = query.location ?? 'India';

    // The user provided the key directly in the request. Usually we use .env, 
    // but we'll fall back to the provided one if env is not set.
    const apiKey = process.env.SERPER_API_KEY || '03a6a5832aa7008001fd5dbaff3de09eea0d4ac2';

    log.info(`[SerperAPI] Fetching Google structure for "${query.keywords}" in "${location}"`);

    try {
        const payload = {
            q: `${query.keywords} jobs in ${location}`,
            gl: 'in', // Geographic location
        };

        const response = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();

        // 1. If Serper returns the dedicated Google Jobs widget parsed output
        if (data.jobs && Array.isArray(data.jobs)) {
            for (const j of data.jobs) {
                allJobs.push({
                    title: j.title || '',
                    company: j.company || 'Unknown',
                    location: j.location || undefined,
                    description: j.snippet || `${j.title} at ${j.company}`,
                    url: j.link || '', // sometimes Serper jobs don't give direct links, only share links or null
                    source: SOURCE_NAME,
                    sourceTier: 'api',
                });
            }
        }

        // 2. Fallback to parsing standard Organic links
        if (allJobs.length === 0 && data.organic && Array.isArray(data.organic)) {
            for (const org of data.organic) {
                if (org.title && org.link) {
                    allJobs.push({
                        title: org.title,
                        company: 'Various / See Link',
                        location: location,
                        description: org.snippet || org.title,
                        url: org.link,
                        source: SOURCE_NAME,
                        sourceTier: 'api',
                    });
                }
            }
        }

        log.info(`[SerperAPI] ✓ Complete: ${allJobs.length} results collected`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: allJobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };

    } catch (err: any) {
        log.error(`[SerperAPI] ✗ Failed: ${err.message}`);

        // Fallback to ScraperAPI if Serper fails?
        return {
            source: SOURCE_NAME,
            tier: 'TIER_1',
            jobs: [],
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}
