/**
 * src/services/ollamaExtractor.ts
 *
 * Ollama-powered LLM extraction service for the job crawler pipeline.
 *
 * RESPONSIBILITIES
 * ────────────────
 *  1. HTML → Markdown pre-processing (noise stripping via Turndown)
 *  2. Structured job extraction via Ollama /api/chat (JSON mode)
 *  3. Fresher-relevance filtering (post-extraction hard filter)
 *  4. Field normalization to unified OllamaJobRecord schema
 *  5. Ollama health check at crawler startup
 *
 * DESIGN DECISIONS
 * ────────────────
 *  • Raw fetch() — no LangChain, no wrapper libraries
 *  • Sequential processing — CPU inference is slower with parallelism
 *  • All errors caught and logged — never propagates to crash the crawler
 *  • Model + base URL from env (OLLAMA_MODEL / OLLAMA_BASE_URL)
 */

import TurndownService from 'turndown';
import crypto from 'crypto';

// ─── Environment Configuration ──────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:32b-instruct-q8_0';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE ?? 0);
const OLLAMA_MAX_TOKENS = Number(process.env.OLLAMA_MAX_TOKENS ?? 4096);

// ─── Global Ollama availability flag ────────────────────────────────────────

let OLLAMA_AVAILABLE = false;

export function isOllamaAvailable(): boolean {
    return OLLAMA_AVAILABLE;
}

export function setOllamaAvailable(val: boolean): void {
    OLLAMA_AVAILABLE = val;
}

// ─── Queue depth tracker (Part 4 — performance monitoring) ──────────────────

let ollamaQueueDepth = 0;

export function getOllamaQueueDepth(): number {
    return ollamaQueueDepth;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OllamaJobRecord {
    title: string;
    company: string;
    location: string;
    experience: string;          // raw as found on page
    jobType: string;
    applyLink: string;
    source: string;
    isFresher: boolean;
    fresherReason: string;
    experienceNormalized: 'Fresher' | '0-1 years' | '1-2 years' | '2+ years' | 'Unknown';
    rawDescription: string | null;
}

export interface NormalizedJobRecord extends OllamaJobRecord {
    id: string;
}

// ─── Part 1A: HTML → Markdown Pre-processor ─────────────────────────────────

/**
 * Strip noisy HTML tags and convert to compact Markdown to reduce token count
 * before sending to Ollama. Hard cap at 5000 chars.
 */
export function htmlToMarkdown(html: string): string {
    const td = new TurndownService({ headingStyle: 'atx' });

    // Strip noisy tags before conversion
    const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<img[^>]*>/gi, '');

    return td.turndown(cleaned).slice(0, 5000); // hard cap at 5000 chars
}

// ─── Part 1B: Core Ollama Extraction Function ───────────────────────────────

const EXTRACTION_PROMPT = (markdown: string, pageUrl: string, sourceName: string) => `
You are a job data extraction engine. Extract ALL job listings visible in the content below.
Source platform: ${sourceName}
Page URL: ${pageUrl}

Return ONLY a valid JSON array. No explanation. No markdown. No code fences.
Each object must match this exact schema:
{
  "title": "exact job title",
  "company": "company name",
  "location": "city or remote",
  "experience": "experience as stated on page",
  "jobType": "Full Time | Internship | Part Time | Contract",
  "applyLink": "full URL or relative path to apply",
  "isFresher": true or false,
  "fresherReason": "one sentence why",
  "experienceNormalized": "Fresher | 0-1 years | 1-2 years | 2+ years | Unknown",
  "rawDescription": "first 200 chars of job description or null"
}

Rules:
- isFresher = true if experience <= 1 year OR title contains intern/fresher/trainee/graduate/entry
- isFresher = false if requires 2+ years experience
- If applyLink is relative (e.g. /jobs/123), prepend the domain from pageUrl
- If a field is not found, use empty string "" — never use null except for rawDescription
- Extract ALL jobs visible on the page, not just the first one

Page content:
${markdown}
`;

/**
 * Send page HTML to Ollama for structured job extraction.
 *
 * @param html - Raw HTML from page.innerHTML('body')
 * @param pageUrl - The URL of the page being processed
 * @param sourceName - Label like "CUTSHORT_HUB", "SHINE_DETAIL", etc.
 * @param ollamaBaseUrl - Ollama server URL (default: env OLLAMA_BASE_URL)
 * @returns Array of extracted OllamaJobRecord objects
 */
export async function extractJobsFromHtml(
    html: string,
    pageUrl: string,
    sourceName: string,
    ollamaBaseUrl: string = OLLAMA_BASE_URL
): Promise<OllamaJobRecord[]> {
    const markdown = htmlToMarkdown(html);

    if (markdown.trim().length < 50) {
        console.warn(`[OllamaExtractor] Markdown too short (${markdown.length} chars) for ${sourceName} — skipping`);
        return [];
    }

    const body = {
        model: OLLAMA_MODEL,
        format: 'json',
        options: {
            temperature: OLLAMA_TEMPERATURE,
            num_predict: OLLAMA_MAX_TOKENS,
            stop: ['```'],
        },
        messages: [
            {
                role: 'system',
                content: 'You are a structured data extraction engine. Always respond with valid JSON only. Never add commentary.',
            },
            {
                role: 'user',
                content: EXTRACTION_PROMPT(markdown, pageUrl, sourceName),
            },
        ],
        stream: false,
    };

    ollamaQueueDepth++;
    console.info(`[OllamaQueue] Depth: ${ollamaQueueDepth} (starting ${sourceName})`);

    try {
        const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        });

        if (!res.ok) {
            throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as { message: { content: string } };
        const raw = data.message.content.trim();

        // Parse and validate
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Attempt to extract JSON array from response if model added extra text
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) {
                console.warn(`[OllamaExtractor] Failed to parse JSON from ${sourceName}: ${raw.slice(0, 200)}`);
                return [];
            }
            parsed = JSON.parse(match[0]);
        }

        // Handle case where model returned a wrapper object like { "jobs": [...] }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            // Look for an array property
            const arrayKey = Object.keys(obj).find(k => Array.isArray(obj[k]));
            if (arrayKey) {
                parsed = obj[arrayKey];
            } else {
                // Model returned single object instead of array
                return [sanitizeJobRecord(obj as unknown as Partial<OllamaJobRecord>, pageUrl, sourceName)];
            }
        }

        if (!Array.isArray(parsed)) {
            console.warn(`[OllamaExtractor] Unexpected response type from ${sourceName}`);
            return [];
        }

        return (parsed as OllamaJobRecord[]).map(j => sanitizeJobRecord(j, pageUrl, sourceName));
    } finally {
        ollamaQueueDepth--;
    }
}

/**
 * Ensure each extracted record has all required fields with safe defaults.
 */
function sanitizeJobRecord(
    raw: Partial<OllamaJobRecord>,
    pageUrl: string,
    sourceName: string
): OllamaJobRecord {
    // Fix relative apply links
    let applyLink = raw.applyLink ?? '';
    if (applyLink && !applyLink.startsWith('http')) {
        try {
            const base = new URL(pageUrl);
            applyLink = `${base.origin}${applyLink.startsWith('/') ? '' : '/'}${applyLink}`;
        } catch {
            // pageUrl parsing failed — leave as-is
        }
    }

    return {
        title: raw.title?.trim() ?? '',
        company: raw.company?.trim() ?? '',
        location: raw.location?.trim() ?? '',
        experience: raw.experience?.trim() ?? '',
        jobType: raw.jobType?.trim() ?? 'Full Time',
        applyLink,
        source: sourceName.replace('_HUB', '').replace('_DETAIL', '').toLowerCase(),
        isFresher: raw.isFresher ?? false,
        fresherReason: raw.fresherReason ?? '',
        experienceNormalized: raw.experienceNormalized ?? 'Unknown',
        rawDescription: raw.rawDescription ?? null,
    };
}

// ─── Part 1C: Fresher Filter (post-extraction) ─────────────────────────────

/**
 * Hard-filter non-fresher jobs BEFORE they reach the dedup store.
 * Uses both isFresher flag (LLM-determined) and experienceNormalized as fallback.
 */
export function filterFresherOnly(jobs: OllamaJobRecord[]): OllamaJobRecord[] {
    return jobs.filter(j => {
        if (j.isFresher) return true;
        // Secondary check: normalized experience
        if (j.experienceNormalized === 'Fresher' || j.experienceNormalized === '0-1 years') return true;
        return false;
    });
}

// ─── Part 5: Unified JobRecord Normalizer ───────────────────────────────────

/**
 * Normalize an OllamaJobRecord with a deterministic ID and clean fields.
 * Called after extraction + fresher filtering, before dedup store insertion.
 */
export function normalizeJobRecord(raw: OllamaJobRecord, source: string): NormalizedJobRecord {
    const applyLink = raw.applyLink?.startsWith('http')
        ? raw.applyLink
        : `https://${source.toLowerCase().replace('_hub', '').replace('_detail', '')}.com${raw.applyLink}`;

    const id = crypto
        .createHash('sha256')
        .update(`${raw.title}|${raw.company}|${applyLink}`)
        .digest('hex')
        .slice(0, 16);

    return {
        ...raw,
        id,
        title: raw.title?.trim() ?? '',
        company: raw.company?.trim() ?? '',
        location: raw.location?.trim() || 'India',
        jobType: raw.jobType ?? 'Full Time',
        experienceNormalized: raw.experienceNormalized ?? 'Unknown',
        source: source.replace('_HUB', '').replace('_DETAIL', '').toLowerCase(),
        applyLink,
    };
}

// ─── Part 3: Ollama Health Check ────────────────────────────────────────────

/**
 * Verify Ollama is running and the required model is available.
 * Called at crawler startup. Returns true if healthy, false otherwise.
 *
 * If false → log WARN but do NOT abort the crawl.
 * Set OLLAMA_AVAILABLE = false and fall back to selector-based extraction.
 */
export async function checkOllamaHealth(
    baseUrl: string = OLLAMA_BASE_URL
): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
            console.error(`[OllamaHealth] ❌ Ollama returned HTTP ${res.status}`);
            return false;
        }

        const data = await res.json() as { models: { name: string }[] };
        const available = data.models.map(m => m.name);
        const required = OLLAMA_MODEL;

        // Flexible match: check if any model name contains the base model identifier
        const modelBase = required.split(':')[0];  // e.g. "qwen2.5"
        if (!available.some(m => m.includes(modelBase))) {
            console.error(
                `[OllamaHealth] ❌ Required model not found. Available: [${available.join(', ')}]. ` +
                `Run: ollama pull ${required}`
            );
            return false;
        }

        console.info(`[OllamaHealth] ✅ Ollama running at ${baseUrl}. Model available: ${required}`);
        return true;
    } catch (err) {
        console.error(`[OllamaHealth] ❌ Ollama not reachable at ${baseUrl}: ${(err as Error).message}`);
        return false;
    }
}

// ─── Convenience: convert OllamaJobRecord → StorableJob format ──────────────

/**
 * Bridge between Ollama's OllamaJobRecord and the existing StorableJob from jobStore.ts.
 * Allows Ollama-extracted jobs to flow into the existing dedup + DB pipeline.
 */
export function toStorableJob(
    record: OllamaJobRecord | NormalizedJobRecord,
    pageUrl: string
): Record<string, unknown> {
    return {
        url: record.applyLink || pageUrl,
        title: record.title,
        company: record.company,
        description: record.rawDescription ?? `${record.title} at ${record.company}`,
        location: record.location || undefined,
        experience: record.experience || undefined,
        jobType: record.jobType || undefined,
        source: record.source,
        sourceTier: 'headless',
        applyUrl: record.applyLink || pageUrl,
        scrapedAt: new Date().toISOString(),
    };
}
