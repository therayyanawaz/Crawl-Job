import TurndownService from 'turndown';
import crypto from 'crypto';
import { loadLLMConfig, type LLMProviderConfig } from '../utils/modelSelectBridge.js';
import { getCachedResult, setCachedResult } from '../utils/llmCache.js';
import { getDailySpend, isBudgetExceeded, recordTokenUsage } from '../utils/costGuard.js';

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

const JOB_EXTRACTION_SCHEMA = {
    name: 'extract_jobs',
    description: 'Extract all job listings from the page content as structured data',
    parameters: {
        type: 'object',
        properties: {
            jobs: {
                type: 'array',
                description: 'Array of all job listings found on the page',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Exact job title' },
                        company: { type: 'string', description: 'Company name' },
                        location: { type: 'string', description: 'City or "remote"' },
                        experience: { type: 'string', description: 'Experience requirement as stated on page' },
                        jobType: { type: 'string', enum: ['Full Time', 'Internship', 'Part Time', 'Contract'] },
                        applyLink: { type: 'string', description: 'Full URL or relative path to apply' },
                        isFresher: { type: 'boolean', description: 'True if experience <= 1 year or title contains intern/fresher/trainee/graduate/entry' },
                        fresherReason: { type: 'string', description: 'One sentence why isFresher is true or false' },
                        experienceNormalized: { type: 'string', enum: ['Fresher', '0-1 years', '1-2 years', '2+ years', 'Unknown'] },
                        rawDescription: { type: ['string', 'null'], description: 'First 200 chars of job description or null' },
                    },
                    required: ['title', 'company', 'location', 'experience', 'jobType', 'applyLink', 'isFresher', 'fresherReason', 'experienceNormalized'],
                },
            },
        },
        required: ['jobs'],
    },
} as const;

const SYSTEM_PROMPT = 'You are a structured data extraction engine. Always respond with valid JSON only. Never add commentary.';
const ANTHROPIC_SYSTEM_PROMPT = 'You are a structured data extraction engine. You MUST respond with valid JSON only. No markdown. No code fences. No commentary. No explanation. Only raw JSON.';
const SUPPORTS_JSON_MODE = new Set([
    'openai', 'openai-codex', 'groq', 'cerebras',
    'openrouter', 'zai', 'volcengine', 'byteplus', 'minimax',
]);
const OLLAMA_TOOL_MODELS = new Set(['llama3.3', 'llama3.1', 'qwen2.5', 'mistral', 'command-r']);

// Token savings with tool-calling prompt vs full schema prompt:
// Full schema prompt: ~350 tokens per call
// Tool-calling prompt: ~120 tokens per call
// Savings: ~230 tokens/call
// At 1000 calls/day on Claude Sonnet ($3/1M input tokens): ~$0.69/day saved
const TOOL_CALLING_PROMPT = (markdown: string, pageUrl: string, sourceName: string): string => `
Source: ${sourceName}
URL: ${pageUrl}

Extract ALL job listings from the content below.
Rules:
- isFresher=true if experience<=1yr OR title has intern/fresher/trainee/graduate/entry
- Fix relative applyLinks: prepend domain from ${pageUrl}
- Empty string for missing fields, null only for rawDescription

Content:
${markdown}
`.trim();

const FULL_SCHEMA_PROMPT = (markdown: string, pageUrl: string, sourceName: string): string => `
You are a job data extraction engine. Extract ALL job listings from the content below.
Source: ${sourceName}
URL: ${pageUrl}

Return ONLY a valid JSON array. No explanation. No markdown. No code fences.
Each object: { title, company, location, experience, jobType (Full Time|Internship|Part Time|Contract), applyLink (full URL), isFresher (bool), fresherReason, experienceNormalized (Fresher|0-1 years|1-2 years|2+ years|Unknown), rawDescription (string|null) }

Rules:
- isFresher=true if experience<=1yr OR title has intern/fresher/trainee/graduate/entry
- Fix relative applyLinks: prepend domain from ${pageUrl}
- Empty string for missing fields, null only for rawDescription

Content:
${markdown}
`.trim();

function ollamaSupportsToolCalling(modelName: string): boolean {
    const modelBase = modelName.split(':')[0].split('/').pop() ?? '';
    return [...OLLAMA_TOOL_MODELS].some((m) => modelBase.includes(m));
}

function isToolCallingEnabled(config: LLMProviderConfig): boolean {
    if (config.apiFormat === 'anthropic' || config.apiFormat === 'gemini') {
        return true;
    }
    if (config.apiFormat === 'ollama') {
        return ollamaSupportsToolCalling(config.modelName);
    }
    return SUPPORTS_JSON_MODE.has(config.provider);
}

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
    markdown: string,
    pageUrl: string,
    sourceName: string,
    isToolCalling: boolean
): { url: string; headers: Record<string, string>; body: string } {
    const headers = buildHeaders(config);
    const prompt = isToolCalling
        ? TOOL_CALLING_PROMPT(markdown, pageUrl, sourceName)
        : FULL_SCHEMA_PROMPT(markdown, pageUrl, sourceName);

    if (config.apiFormat === 'ollama') {
        const body: Record<string, unknown> = {
            model: config.modelName,
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

        if (isToolCalling) {
            body.tools = [{
                type: 'function',
                function: JOB_EXTRACTION_SCHEMA,
            }];
        } else {
            body.format = 'json';
        }

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

        if (isToolCalling) {
            body.tools = [{
                type: 'function',
                function: JOB_EXTRACTION_SCHEMA,
            }];
            body.tool_choice = {
                type: 'function',
                function: { name: 'extract_jobs' },
            };
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
            messages: [{ role: 'user', content: prompt }],
            tools: [{
                name: JOB_EXTRACTION_SCHEMA.name,
                description: JOB_EXTRACTION_SCHEMA.description,
                input_schema: JOB_EXTRACTION_SCHEMA.parameters,
            }],
            tool_choice: { type: 'tool', name: 'extract_jobs' },
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
        tools: [{
            functionDeclarations: [{
                name: JOB_EXTRACTION_SCHEMA.name,
                description: JOB_EXTRACTION_SCHEMA.description,
                parameters: JOB_EXTRACTION_SCHEMA.parameters,
            }],
        }],
        toolConfig: {
            functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['extract_jobs'] },
        },
        generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
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
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const firstToolCall = asRecord(toolCalls[0]);
        const fn = asRecord(firstToolCall.function);
        if (typeof fn.arguments === 'string') {
            return fn.arguments;
        }
        if (fn.arguments && typeof fn.arguments === 'object') {
            return JSON.stringify(fn.arguments);
        }

        return contentToText(message.content);
    }

    if (config.apiFormat === 'anthropic') {
        const blocks = Array.isArray(root.content) ? root.content.map((b) => asRecord(b)) : [];
        const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
        if (toolUseBlock?.input && typeof toolUseBlock.input === 'object') {
            return JSON.stringify(toolUseBlock.input);
        }

        const textBlock = blocks.find((b) => b.type === 'text');
        return typeof textBlock?.text === 'string' ? textBlock.text : '';
    }

    if (config.apiFormat === 'gemini') {
        const candidates = Array.isArray(root.candidates) ? root.candidates : [];
        const firstCandidate = asRecord(candidates[0]);
        const content = asRecord(firstCandidate.content);
        const parts = Array.isArray(content.parts) ? content.parts.map((p) => asRecord(p)) : [];
        const functionPart = parts.find((p) => p.functionCall && typeof p.functionCall === 'object');
        if (functionPart) {
            const functionCall = asRecord(functionPart.functionCall);
            if (functionCall.args && typeof functionCall.args === 'object') {
                return JSON.stringify(functionCall.args);
            }
            if (typeof functionCall.args === 'string') {
                return functionCall.args;
            }
        }

        const textPart = parts.find((p) => typeof p.text === 'string');
        return typeof textPart?.text === 'string' ? textPart.text : '';
    }

    const choices = Array.isArray(root.choices) ? root.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice.message);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const firstToolCall = asRecord(toolCalls[0]);
    const fn = asRecord(firstToolCall.function);
    if (typeof fn.arguments === 'string') {
        return fn.arguments;
    }
    if (fn.arguments && typeof fn.arguments === 'object') {
        return JSON.stringify(fn.arguments);
    }

    return contentToText(message.content);
}

function logTokenUsage(provider: string, data: unknown): void {
    if (!data || typeof data !== 'object') {
        return;
    }

    const toNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const d = data as Record<string, unknown>;

    if (d.usage && typeof d.usage === 'object') {
        const u = d.usage as Record<string, unknown>;
        const promptTokens = toNumber(u.prompt_tokens);
        const completionTokens = toNumber(u.completion_tokens);
        const totalTokens = toNumber(u.total_tokens);

        if (totalTokens > 0) {
            console.info(
                `[LLMUsage] ${provider} — prompt: ${promptTokens || '?'} ` +
                `completion: ${completionTokens || '?'} ` +
                `total: ${totalTokens} tokens`
            );
            recordTokenUsage(provider, totalTokens);
            const spend = getDailySpend(provider);
            console.info(`[CostGuard] ${provider} daily spend: $${spend.costUSD.toFixed(4)} (${spend.tokens} tokens)`);
            return;
        }

        const inputTokens = toNumber(u.input_tokens);
        const outputTokens = toNumber(u.output_tokens);
        if (inputTokens > 0 || outputTokens > 0) {
            const total = inputTokens + outputTokens;
            console.info(
                `[LLMUsage] ${provider} — input: ${inputTokens} ` +
                `output: ${outputTokens || '?'} tokens`
            );
            if (total > 0) {
                recordTokenUsage(provider, total);
                const spend = getDailySpend(provider);
                console.info(`[CostGuard] ${provider} daily spend: $${spend.costUSD.toFixed(4)} (${spend.tokens} tokens)`);
            }
            return;
        }
    }

    if (d.usageMetadata && typeof d.usageMetadata === 'object') {
        const u = d.usageMetadata as Record<string, unknown>;
        const promptTokenCount = toNumber(u.promptTokenCount);
        const outputTokenCount = toNumber(u.candidatesTokenCount);
        const totalTokenCount = toNumber(u.totalTokenCount);
        console.info(
            `[LLMUsage] ${provider} — prompt: ${promptTokenCount || '?'} ` +
            `output: ${outputTokenCount || '?'} ` +
            `total: ${totalTokenCount || '?'} tokens`
        );
        if (totalTokenCount > 0) {
            recordTokenUsage(provider, totalTokenCount);
            const spend = getDailySpend(provider);
            console.info(`[CostGuard] ${provider} daily spend: $${spend.costUSD.toFixed(4)} (${spend.tokens} tokens)`);
        }
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

async function _extractWithConfig(
    config: LLMProviderConfig,
    html: string,
    pageUrl: string,
    sourceName: string,
    overrideBaseUrl?: string
): Promise<OllamaJobRecord[]> {
    const activeConfig: LLMProviderConfig = overrideBaseUrl
        ? { ...config, baseUrl: overrideBaseUrl }
        : config;

    const cached = getCachedResult(html);
    if (cached) {
        console.info(`[LLMCache] Cache hit for ${sourceName} (provider: ${cached.provider}, model: ${cached.modelId})`);
        return (cached.jobs as OllamaJobRecord[]).map((j) =>
            sanitizeJobRecord(j as Partial<OllamaJobRecord>, pageUrl, sourceName)
        );
    }

    if (isBudgetExceeded(activeConfig.provider)) {
        return [];
    }

    const markdown = htmlToMarkdown(html, getMarkdownCap(activeConfig.provider));
    if (markdown.trim().length < 50) {
        logExtractorWarn(`Markdown too short (${markdown.length} chars) for ${sourceName} — skipping`);
        return [];
    }

    const isToolCalling = isToolCallingEnabled(activeConfig);
    const payload = buildRequestPayload(activeConfig, markdown, pageUrl, sourceName, isToolCalling);

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
            const arrayMatch = raw.match(/\[[\s\S]*\]/);
            const objectMatch = raw.match(/\{[\s\S]*\}/);
            if (arrayMatch) {
                parsed = JSON.parse(arrayMatch[0]);
            } else if (objectMatch) {
                parsed = JSON.parse(objectMatch[0]);
            } else {
                logExtractorWarn(`Failed to parse JSON from ${sourceName}: ${raw.slice(0, 200)}`);
                return [];
            }
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (Array.isArray(obj.jobs)) {
                parsed = obj.jobs;
            } else {
                const arrayKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
                if (arrayKey) {
                    parsed = obj[arrayKey];
                } else {
                    return [sanitizeJobRecord(obj as Partial<OllamaJobRecord>, pageUrl, sourceName)];
                }
            }
        }

        if (!Array.isArray(parsed)) {
            logExtractorWarn(`Unexpected response type from ${sourceName}`);
            return [];
        }

        const result = (parsed as OllamaJobRecord[]).map((j) => sanitizeJobRecord(j, pageUrl, sourceName));
        setCachedResult(html, result, activeConfig.provider, activeConfig.modelId);
        return result;
    } finally {
        llmQueueDepth--;
    }
}

export async function extractJobsFromHtml(
    html: string,
    pageUrl: string,
    sourceName: string,
    ollamaBaseUrl: string = OLLAMA_BASE_URL
): Promise<OllamaJobRecord[]> {
    const config = loadLLMConfig();
    const callerProvidedOverride = arguments.length >= 4;
    const overrideBaseUrl = callerProvidedOverride ? ollamaBaseUrl : undefined;

    try {
        return await _extractWithConfig(config, html, pageUrl, sourceName, overrideBaseUrl);
    } catch (primaryErr) {
        if (config.fallback) {
            console.warn(
                `[LLMExtractor] Primary provider "${config.provider}" failed: ${(primaryErr as Error).message}. ` +
                `Falling back to "${config.fallback.provider}/${config.fallback.modelName}"...`
            );
            try {
                return await _extractWithConfig(config.fallback, html, pageUrl, sourceName, overrideBaseUrl);
            } catch (fallbackErr) {
                console.error(
                    `[LLMExtractor] Fallback provider also failed: ${(fallbackErr as Error).message}. ` +
                    `Returning empty results for ${sourceName}.`
                );
                return [];
            }
        }

        console.error(`[LLMExtractor] Extraction failed (no fallback): ${(primaryErr as Error).message}`);
        return [];
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
