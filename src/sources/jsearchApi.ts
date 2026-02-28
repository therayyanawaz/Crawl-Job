/**
 * src/sources/jsearchApi.ts
 *
 * TIER 2 — SECONDARY SOURCE: JSearch API (RapidAPI)
 *
 * JSearch provides structured job data via a REST API.
 * This is the supplementary "extra topping" layer that fills gaps
 * not covered by Google SERP results.
 *
 * API docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 *
 * KEY MANAGEMENT
 * ──────────────
 * - Primary key is read from JSEARCH_API_KEY env var
 * - On 429/quota errors, the system logs a warning for manual key rotation
 * - Daily quota: ~100-500 requests depending on plan
 */

import { log } from 'crawlee';
import type { RawJobListing, SearchQuery, SourceResult } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_NAME = 'jsearch';
const API_HOST = 'jsearch.p.rapidapi.com';
const API_BASE = `https://${API_HOST}`;

// ─── API Key Management ──────────────────────────────────────────────────────

function getApiKeys(): string[] {
    const keys: string[] = [];

    // Primary key from env
    const primary = process.env.JSEARCH_API_KEY?.trim();
    if (primary) keys.push(primary);

    // Rotation keys (comma-separated)
    const extras = (process.env.JSEARCH_API_KEYS_ROTATION ?? '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);
    keys.push(...extras);

    return keys;
}

let currentKeyIndex = 0;
let exhaustedKeys = new Set<number>();

function getNextKey(): string | null {
    const keys = getApiKeys();
    if (keys.length === 0) return null;

    // Try all keys starting from current index
    for (let i = 0; i < keys.length; i++) {
        const idx = (currentKeyIndex + i) % keys.length;
        if (!exhaustedKeys.has(idx)) {
            currentKeyIndex = idx;
            return keys[idx];
        }
    }

    // All keys exhausted — reset and try primary
    log.warning('[JSearch] All API keys exhausted. Resetting rotation.');
    exhaustedKeys.clear();
    currentKeyIndex = 0;
    return keys[0] ?? null;
}

function markKeyExhausted(): void {
    exhaustedKeys.add(currentKeyIndex);
    currentKeyIndex = (currentKeyIndex + 1) % getApiKeys().length;
    log.warning(`[JSearch] Key #${currentKeyIndex} marked exhausted. Rotating to next.`);
}

// ─── API Caller ───────────────────────────────────────────────────────────────

interface JSearchResponse {
    status: string;
    request_id: string;
    data: JSearchJob[];
}

interface JSearchJob {
    job_id: string;
    employer_name: string;
    employer_logo: string | null;
    job_title: string;
    job_description: string;
    job_apply_link: string;
    job_city: string;
    job_state: string;
    job_country: string;
    job_employment_type: string;
    job_posted_at_datetime_utc: string;
    job_min_salary: number | null;
    job_max_salary: number | null;
    job_salary_currency: string | null;
    job_salary_period: string | null;
    job_is_remote: boolean;
}

async function callJSearchApi(
    endpoint: string,
    params: Record<string, string>,
    retries = 2
): Promise<JSearchResponse | null> {
    const apiKey = getNextKey();
    if (!apiKey) {
        log.error('[JSearch] No API key configured. Set JSEARCH_API_KEY in .env');
        return null;
    }

    const url = `${API_BASE}/${endpoint}?${new URLSearchParams(params).toString()}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            log.debug(`[JSearch] API call attempt ${attempt}/${retries}: ${endpoint}`);

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);

            const response = await fetch(url, {
                headers: {
                    'x-rapidapi-key': apiKey,
                    'x-rapidapi-host': API_HOST,
                },
                signal: controller.signal,
            });

            clearTimeout(timer);

            if (response.status === 429) {
                log.warning(`[JSearch] Rate limited (429) on key: ${apiKey.slice(0, 6)}... Rotating.`);
                markKeyExhausted();
                const nextKey = getNextKey();
                if (nextKey && nextKey !== apiKey) {
                    continue;
                }
                return null;
            }

            if (response.status === 403) {
                log.warning(`[JSearch] Forbidden (403) on key: ${apiKey.slice(0, 6)}... Rotating.`);
                markKeyExhausted();
                return null;
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                log.warning(`[JSearch] HTTP ${response.status}: ${body.slice(0, 200)}`);
                if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }

            return await response.json() as JSearchResponse;

        } catch (err: any) {
            log.warning(`[JSearch] Attempt ${attempt} error: ${err.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }

    return null;
}

// ─── Response Mapper ──────────────────────────────────────────────────────────

function mapJSearchJob(job: JSearchJob): RawJobListing {
    const locationParts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
    const location = job.job_is_remote ? 'Remote' : locationParts.join(', ') || undefined;

    let salary: string | undefined;
    if (job.job_min_salary && job.job_max_salary) {
        salary = `${job.job_salary_currency ?? '₹'}${job.job_min_salary}-${job.job_max_salary}/${job.job_salary_period ?? 'year'}`;
    } else if (job.job_min_salary) {
        salary = `${job.job_salary_currency ?? '₹'}${job.job_min_salary}+/${job.job_salary_period ?? 'year'}`;
    }

    return {
        title: job.job_title,
        company: job.employer_name ?? 'Unknown',
        location,
        description: (job.job_description ?? '').slice(0, 5000),
        url: job.job_apply_link ?? '',
        salary,
        jobType: job.job_employment_type ?? undefined,
        postedDate: job.job_posted_at_datetime_utc ?? undefined,
        source: SOURCE_NAME,
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchJSearchJobs(query: SearchQuery): Promise<SourceResult> {
    const start = Date.now();
    const maxResults = query.maxResults ?? 50;

    log.info(`[JSearch] Starting API fetch: "${query.keywords}" in "${query.location ?? 'India'}"`);

    try {
        const params: Record<string, string> = {
            query: query.location
                ? `${query.keywords} in ${query.location}`
                : query.keywords,
            page: '1',
            num_pages: String(Math.ceil(maxResults / 10)),
            date_posted: 'week',  // Recent jobs only
            country: 'in',
        };

        const response = await callJSearchApi('search', params);

        if (!response || !response.data) {
            return {
                source: SOURCE_NAME,
                tier: 'TIER_0',
                jobs: [],
                durationMs: Date.now() - start,
                error: 'No data returned from JSearch API',
            };
        }

        const jobs = response.data.map(mapJSearchJob).filter(j => j.title && j.url);

        log.info(`[JSearch] ✓ Complete: ${jobs.length} jobs fetched via API`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: jobs.slice(0, maxResults),
            durationMs: Date.now() - start,
        };

    } catch (err: any) {
        log.error(`[JSearch] ✗ Failed: ${err.message}`);
        return {
            source: SOURCE_NAME,
            tier: 'TIER_0',
            jobs: [],
            durationMs: Date.now() - start,
            error: err.message,
        };
    }
}

/**
 * Reset exhausted keys — call at the start of each daily run.
 */
export function resetJSearchKeyRotation(): void {
    exhaustedKeys.clear();
    currentKeyIndex = 0;
    log.info('[JSearch] API key rotation reset.');
}
