import TurndownService from 'turndown';
import crypto from 'crypto';
import { loadLLMConfig, type LLMProviderConfig } from '../utils/modelSelectBridge.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

let OLLAMA_AVAILABLE = false;

export function isOllamaAvailable(): boolean {
    return OLLAMA_AVAILABLE;
}

export function setOllamaAvailable(val: boolean): void {
    OLLAMA_AVAILABLE = val;
}

let llmQueueDepth = 0;

export function getOllamaQueueDepth(): number {
    return llmQueueDepth;
}

export interface OllamaJobRecord {
    title: string;
    company: string;
    location: string;
    experience: string;
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

const SYSTEM_PROMPT = 'You are a structured data extraction engine. Always respond with valid JSON only. Never add commentary.';
const ANTHROPIC_SYSTEM_PROMPT = 'You are a structured data extraction engine. You MUST respond with valid JSON only. No markdown. No code fences. No commentary. No explanation. Only raw JSON.';
const ANTHROPIC_PROMPT_SUFFIX = 'IMPORTANT: Your entire response must be a valid JSON array. Start with [ and end with ].\nDo not include any other text, markdown, or explanation before or after the JSON.';
const SUPPORTS_JSON_MODE = new Set([
    'openai', 'openai-codex', 'groq', 'cerebras',
    'openrouter', 'zai', 'volcengine', 'byteplus', 'minimax',
]);

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

function logExtractorWarn(message: string): void {
    console.warn(`[LLMExtractor] ${message}`);
    console.warn(`[OllamaExtractor] ${message}`);
}

function logExtractorInfo(message: string): void {
    console.info(`[LLMExtractor] ${message}`);
    console.info(`[OllamaExtractor] ${message}`);
}

function logQueue(message: string): void {
    console.info(`[LLMQueue] ${message}`);
    console.info(`[OllamaQueue] ${message}`);
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function buildOpenAIResourceUrl(baseUrl: string, resourcePath: string): string {
    const normalized = trimTrailingSlash(baseUrl);
    if (/\/v1$/i.test(normalized)) {
        return `${normalized}/${resourcePath}`;
    }

    return `${normalized}/v1/${resourcePath}`;
}

function buildHeaders(config: LLMProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.extraHeaders,
    };

    if (config.authHeader && config.apiKey) {
        headers[config.authHeader] = config.authHeader === 'Authorization'
            ? `Bearer ${config.apiKey}`
            : config.apiKey;
    }

    return headers;
}

export function htmlToMarkdown(html: string, maxChars: number = 5000): string {
    const td = new TurndownService({ headingStyle: 'atx' });

    const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<img[^>]*>/gi, '');

    return td.turndown(cleaned).slice(0, maxChars);
}

export function buildRequestPayload(
    config: LLMProviderConfig,
    prompt: string
): { url: string; headers: Record<string, string>; body: string } {
    const headers = buildHeaders(config);

    if (config.apiFormat === 'ollama') {
        const body = {
            model: config.modelName,
            format: 'json',
            options: {
                temperature: config.temperature,
                num_predict: config.maxTokens,
                stop: ['```'],
            },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            stream: false,
        };

        return {
            url: `${trimTrailingSlash(config.baseUrl)}/api/chat`,
            headers,
            body: JSON.stringify(body),
        };
    }

    if (config.apiFormat === 'openai') {
        const body: Record<string, unknown> = {
            model: config.modelName,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            stream: false,
        };

        if (SUPPORTS_JSON_MODE.has(config.provider)) {
            body.response_format = { type: 'json_object' };
        }

        return {
            url: buildOpenAIResourceUrl(config.baseUrl, 'chat/completions'),
            headers,
            body: JSON.stringify(body),
        };
    }

    if (config.apiFormat === 'anthropic') {
        const body = {
            model: config.modelName,
            max_tokens: config.maxTokens,
            system: ANTHROPIC_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `${prompt}\n\n${ANTHROPIC_PROMPT_SUFFIX}` }],
        };

        return {
            url: `${trimTrailingSlash(config.baseUrl)}/v1/messages`,
            headers,
            body: JSON.stringify(body),
        };
    }

    if (!config.apiKey) {
        throw new Error('Gemini API key is missing');
    }

    const body = {
        contents: [
            {
                role: 'user',
                parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }],
            },
        ],
        generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: 'application/json',
        },
    };

    return {
        url: `${trimTrailingSlash(config.baseUrl)}/v1beta/models/${encodeURIComponent(config.modelName)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
        headers,
        body: JSON.stringify(body),
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function contentToText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }

                const partObj = asRecord(part);
                return typeof partObj.text === 'string' ? partObj.text : '';
            })
            .join('')
            .trim();
    }

    return '';
}

export function parseResponseContent(config: LLMProviderConfig, data: unknown): string {
    const root = asRecord(data);

    if (config.apiFormat === 'ollama') {
        const message = asRecord(root.message);
        return contentToText(message.content);
    }

    if (config.apiFormat === 'anthropic') {
        const blocks = Array.isArray(root.content) ? root.content : [];
        const firstBlock = asRecord(blocks[0]);
        return contentToText(firstBlock.text);
    }

    if (config.apiFormat === 'gemini') {
        const candidates = Array.isArray(root.candidates) ? root.candidates : [];
        const firstCandidate = asRecord(candidates[0]);
        const content = asRecord(firstCandidate.content);
        const parts = Array.isArray(content.parts) ? content.parts : [];
        const firstPart = asRecord(parts[0]);
        return contentToText(firstPart.text);
    }

    const choices = Array.isArray(root.choices) ? root.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice.message);
    return contentToText(message.content);
}

function logTokenUsage(provider: string, data: unknown): void {
    if (!data || typeof data !== 'object') {
        return;
    }

    const d = data as Record<string, unknown>;

    if (d.usage && typeof d.usage === 'object') {
        const u = d.usage as Record<string, number>;
        if (u.total_tokens) {
            console.info(
                `[LLMUsage] ${provider} — prompt: ${u.prompt_tokens ?? '?'} ` +
                `completion: ${u.completion_tokens ?? '?'} ` +
                `total: ${u.total_tokens} tokens`
            );
            return;
        }
    }

    if (d.usage && typeof d.usage === 'object') {
        const u = d.usage as Record<string, number>;
        if (u.input_tokens) {
            console.info(
                `[LLMUsage] ${provider} — input: ${u.input_tokens} ` +
                `output: ${u.output_tokens ?? '?'} tokens`
            );
            return;
        }
    }

    if (d.usageMetadata && typeof d.usageMetadata === 'object') {
        const u = d.usageMetadata as Record<string, number>;
        console.info(
            `[LLMUsage] ${provider} — prompt: ${u.promptTokenCount ?? '?'} ` +
            `output: ${u.candidatesTokenCount ?? '?'} ` +
            `total: ${u.totalTokenCount ?? '?'} tokens`
        );
    }
}

async function fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = 3
): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);

            if (res.status === 429 || res.status >= 500) {
                const retryAfter = res.headers.get('retry-after');
                const parsedRetryAfter = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
                const waitMs = Number.isFinite(parsedRetryAfter)
                    ? parsedRetryAfter * 1000
                    : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);

                console.warn(
                    `[LLMExtractor] HTTP ${res.status} on attempt ${attempt + 1}/${maxRetries}. ` +
                    `Retrying in ${Math.round(waitMs / 1000)}s...`
                );

                if (attempt < maxRetries - 1) {
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                }

                return res;
            }

            return res;
        } catch (err) {
            lastError = err as Error;
            const waitMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 15000);
            console.warn(
                `[LLMExtractor] Network error on attempt ${attempt + 1}/${maxRetries}: ` +
                `${(err as Error).message}. Retrying in ${Math.round(waitMs / 1000)}s...`
            );
            if (attempt < maxRetries - 1) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
        }
    }

    throw lastError ?? new Error('fetchWithRetry: all attempts failed');
}

function getMarkdownCap(provider: string): number {
    const LOW_CAP = new Set(['anthropic', 'openai', 'openai-codex', 'google']);
    const HIGH_CAP = new Set(['groq', 'cerebras', 'ollama', 'lmstudio']);

    if (LOW_CAP.has(provider)) {
        return 3500;
    }
    if (HIGH_CAP.has(provider)) {
        return 7000;
    }

    return 5000;
}

export async function extractJobsFromHtml(
    html: string,
    pageUrl: string,
    sourceName: string,
    ollamaBaseUrl: string = OLLAMA_BASE_URL
): Promise<OllamaJobRecord[]> {
    const config = loadLLMConfig();
    const callerProvidedOverride = arguments.length >= 4;
    const activeConfig: LLMProviderConfig = callerProvidedOverride
        ? { ...config, baseUrl: ollamaBaseUrl }
        : config;

    const markdown = htmlToMarkdown(html, getMarkdownCap(activeConfig.provider));
    if (markdown.trim().length < 50) {
        logExtractorWarn(`Markdown too short (${markdown.length} chars) for ${sourceName} — skipping`);
        return [];
    }

    const prompt = EXTRACTION_PROMPT(markdown, pageUrl, sourceName);
    const payload = buildRequestPayload(activeConfig, prompt);

    llmQueueDepth++;
    logQueue(`Depth: ${llmQueueDepth} (starting ${sourceName})`);

    try {
        const res = await fetchWithRetry(payload.url, {
            method: 'POST',
            headers: payload.headers,
            body: payload.body,
            signal: AbortSignal.timeout(activeConfig.timeoutMs),
        }, activeConfig.provider === 'ollama' || activeConfig.provider === 'lmstudio' ? 1 : 3);

        if (!res.ok) {
            throw new Error(`LLM error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as unknown;
        logTokenUsage(activeConfig.provider, data);
        const raw = parseResponseContent(activeConfig, data).trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) {
                logExtractorWarn(`Failed to parse JSON from ${sourceName}: ${raw.slice(0, 200)}`);
                return [];
            }
            parsed = JSON.parse(match[0]);
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            const arrayKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
            if (arrayKey) {
                parsed = obj[arrayKey];
            } else {
                return [sanitizeJobRecord(obj as Partial<OllamaJobRecord>, pageUrl, sourceName)];
            }
        }

        if (!Array.isArray(parsed)) {
            logExtractorWarn(`Unexpected response type from ${sourceName}`);
            return [];
        }

        return (parsed as OllamaJobRecord[]).map((j) => sanitizeJobRecord(j, pageUrl, sourceName));
    } finally {
        llmQueueDepth--;
    }
}

export function sanitizeJobRecord(
    raw: Partial<OllamaJobRecord>,
    pageUrl: string,
    sourceName: string
): OllamaJobRecord {
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

export function filterFresherOnly(jobs: OllamaJobRecord[]): OllamaJobRecord[] {
    return jobs.filter((j) => {
        if (j.isFresher) {
            return true;
        }
        if (j.experienceNormalized === 'Fresher' || j.experienceNormalized === '0-1 years') {
            return true;
        }
        return false;
    });
}

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

export async function checkLLMHealth(config: LLMProviderConfig = loadLLMConfig()): Promise<boolean> {
    const provider = config.provider;

    try {
        if (provider === 'ollama') {
            const res = await fetch(`${trimTrailingSlash(config.baseUrl)}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
                console.error(`[LLMHealth] ❌ ${provider} not reachable: HTTP ${res.status}`);
                return false;
            }

            const data = await res.json() as { models?: { name: string }[] };
            const available = (data.models ?? []).map((m) => m.name);
            const required = config.modelName;
            const modelBase = required.split(':')[0];

            if (!available.some((m) => m.includes(modelBase))) {
                console.error(
                    `[LLMHealth] ❌ ${provider} not reachable: required model not found (${required}). ` +
                    `Available: [${available.join(', ')}]`
                );
                return false;
            }

            console.info(`[LLMHealth] ✅ ${provider} ready. Model: ${config.modelId}`);
            return true;
        }

        let url = '';
        if (provider === 'lmstudio') {
            url = buildOpenAIResourceUrl(config.baseUrl, 'models');
        } else if (config.apiFormat === 'anthropic') {
            url = 'https://api.anthropic.com/v1/models';
        } else if (config.apiFormat === 'gemini') {
            if (!config.apiKey) {
                console.error('[LLMHealth] ❌ google not reachable: API key is missing');
                return false;
            }
            url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey}`;
        } else {
            url = buildOpenAIResourceUrl(config.baseUrl, 'models');
        }

        const headers = buildHeaders(config);
        if (config.apiFormat === 'gemini') {
            delete headers.Authorization;
            delete headers['x-api-key'];
        }

        const res = await fetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(5000),
        });

        if (res.status === 200 || res.status === 201) {
            console.info(`[LLMHealth] ✅ ${provider} ready. Model: ${config.modelId}`);
            return true;
        }

        console.error(`[LLMHealth] ❌ ${provider} not reachable: HTTP ${res.status}`);
        return false;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[LLMHealth] ❌ ${provider} not reachable: ${message}`);
        return false;
    }
}

export const checkOllamaHealth = checkLLMHealth;

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
