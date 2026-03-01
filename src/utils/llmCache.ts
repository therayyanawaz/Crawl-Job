import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'storage', 'llm-cache');
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

interface CacheEntry {
    jobs: unknown[];
    cachedAt: number;
    provider: string;
    modelId: string;
}

function getCachePath(hash: string): string {
    return path.join(CACHE_DIR, `${hash}.json`);
}

export function hashContent(html: string): string {
    return crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
}

export function getCachedResult(html: string): CacheEntry | null {
    const hash = hashContent(html);
    const filepath = getCachePath(hash);
    if (!existsSync(filepath)) {
        return null;
    }

    try {
        const entry = JSON.parse(readFileSync(filepath, 'utf8')) as CacheEntry;
        if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
            return null;
        }

        return entry;
    } catch {
        return null;
    }
}

export function setCachedResult(html: string, jobs: unknown[], provider: string, modelId: string): void {
    try {
        if (!existsSync(CACHE_DIR)) {
            mkdirSync(CACHE_DIR, { recursive: true });
        }

        const hash = hashContent(html);
        const entry: CacheEntry = {
            jobs,
            cachedAt: Date.now(),
            provider,
            modelId,
        };

        writeFileSync(getCachePath(hash), JSON.stringify(entry));
    } catch (err) {
        console.warn(`[LLMCache] Failed to write cache: ${(err as Error).message}`);
    }
}

export function getCacheStats(): { entries: number; sizeKB: number } {
    if (!existsSync(CACHE_DIR)) {
        return { entries: 0, sizeKB: 0 };
    }

    try {
        const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
        const totalBytes = files.reduce((sum, f) => sum + statSync(path.join(CACHE_DIR, f)).size, 0);
        return { entries: files.length, sizeKB: Math.round(totalBytes / 1024) };
    } catch {
        return { entries: 0, sizeKB: 0 };
    }
}
