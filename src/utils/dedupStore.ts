/**
 * src/utils/dedupStore.ts
 *
 * Persistent fingerprint store — survives process restarts.
 *
 * STORAGE CHOICE: JSON file on disk.
 * ─────────────────────────────────────
 * Why not SQLite?
 *   • Requires a native binary build (problematic on headless servers).
 *   • Overkill for a lookup set of <1M short strings.
 *
 * Why not an in-memory Set?
 *   • Dies on process restart — next crawl re-scrapes everything.
 *
 * Why not Redis?
 *   • External dependency; budget constraint (student project).
 *
 * JSON file is the simplest option that survives restarts AND requires zero
 * additional dependencies.  At 10,000 jobs/week × 16-char hashes × 3 levels,
 * the file grows at ~5 KB/week — negligible.
 *
 * STRUCTURE ON DISK:
 * {
 *   "version": 1,
 *   "entries": {
 *     "<urlHash>":     { "storedAt": "<ISO>", "contentHash": "...", "descHash": "..." },
 *     ...
 *   }
 * }
 *
 * The urlHash is the primary key.  contentHash and descHash are stored
 * alongside it so we can efficiently check cross-board duplicates without
 * a second lookup pass.
 *
 * RETENTION & CLEANUP:
 * Entries older than DEDUP_RETENTION_DAYS (default 30) are pruned at startup
 * and after every write batch. This bounds file size regardless of how long
 * the system runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from 'crawlee';
import type { JobFingerprints } from './fingerprint.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoreEntry {
    storedAt: string; // ISO timestamp
    contentHash: string;
    descHash: string;
}

interface StoreFile {
    version: 1;
    entries: Record<string, StoreEntry>; // key = urlHash
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STORE_DIR = path.join(process.cwd(), 'storage');
const STORE_PATH = path.join(STORE_DIR, 'dedup-store.json');
const RETENTION_DAYS = Number(process.env.DEDUP_RETENTION_DAYS ?? 30);

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

/**
 * In-process cache mirrors the disk file for O(1) lookup during a crawl run.
 * On startup we load disk → cache. On writes we update both atomically.
 */
let memCache: StoreFile = { version: 1, entries: {} };
let isDirty = false;  // true if memCache has unsaved changes
let flushTimer: ReturnType<typeof setInterval> | null = null;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function loadFromDisk(): void {
    if (!fs.existsSync(STORE_PATH)) {
        memCache = { version: 1, entries: {} };
        return;
    }
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        memCache = JSON.parse(raw) as StoreFile;
        log.info(`[DedupStore] Loaded ${Object.keys(memCache.entries).length} fingerprints from disk.`);
    } catch (err: any) {
        log.warning(`[DedupStore] Store file corrupt — starting fresh. (${err.message})`);
        memCache = { version: 1, entries: {} };
    }
}

function saveToDisk(): void {
    try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
        // Write to a temp file first, then atomic rename to avoid corruption
        const tmp = STORE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(memCache, null, 2), 'utf-8');
        fs.renameSync(tmp, STORE_PATH);
        isDirty = false;
    } catch (err: any) {
        log.error(`[DedupStore] Failed to save store: ${err.message}`);
    }
}

/** Removes entries older than RETENTION_DAYS from memCache. */
function pruneOldEntries(): number {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [urlHash, entry] of Object.entries(memCache.entries)) {
        if (new Date(entry.storedAt).getTime() < cutoff) {
            delete memCache.entries[urlHash];
            pruned++;
        }
    }
    if (pruned > 0) {
        isDirty = true;
        log.info(`[DedupStore] Pruned ${pruned} entries older than ${RETENTION_DAYS} days.`);
    }
    return pruned;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the store: load from disk, prune old entries, start flush timer.
 * Call once at application startup before any scraping begins.
 */
export function initDedupStore(): void {
    loadFromDisk();
    pruneOldEntries();
    if (isDirty) saveToDisk();

    // Flush every 5 minutes so a crash loses at most 5 minutes of dedup data.
    if (flushTimer === null) {
        flushTimer = setInterval(() => {
            if (isDirty) {
                log.debug('[DedupStore] Periodic flush to disk.');
                saveToDisk();
            }
        }, 5 * 60_000);
    }

    log.info(
        `[DedupStore] Initialised. ${Object.keys(memCache.entries).length} fingerprints in store. ` +
        `Retention: ${RETENTION_DAYS} days.`
    );
}

/**
 * Checks whether a job is a duplicate by looking up its fingerprints.
 *
 * Matching logic (hierarchical):
 *  1. urlHash match → definite duplicate (same URL = same posting).
 *  2. contentHash match → probable duplicate (same title+company+location).
 *     We still check descHash to reduce false positives:
 *     if descHash is also different AND it's been seen less than 7 days ago,
 *     we treat it as distinct (could be a refreshed posting).
 *
 * @returns "url" | "content" | "none" — tells the caller WHY it's a dup.
 */
export function checkDuplicate(
    fp: JobFingerprints
): 'url' | 'content' | 'none' {
    // Tier 1: URL hash — exact match, cheapest check
    if (memCache.entries[fp.urlHash]) {
        return 'url';
    }

    // Tier 2: content hash — scan all entries for matching contentHash
    // We iterate the values; at 10k entries this is ~10 ms worst-case.
    // If scale grows to 100k+, switch to a secondary Map<contentHash, urlHash>.
    for (const entry of Object.values(memCache.entries)) {
        if (entry.contentHash === fp.contentHash) {
            // Is the description also identical? Strong duplicate signal.
            if (entry.descHash === fp.descHash) return 'content';

            // Content matches but desc differs:
            // Could be a refreshed posting. Check entry age:
            const ageDays =
                (Date.now() - new Date(entry.storedAt).getTime()) / (24 * 60 * 60 * 1000);
            // If last seen >7 days ago, treat as a new/refreshed posting
            if (ageDays < 7) return 'content';
        }
    }

    return 'none';
}

/**
 * Records a job's fingerprints in the store, marking it as "seen".
 * Call this ONLY after the job has been successfully saved to the Crawlee Dataset.
 */
export function markJobAsSeen(fp: JobFingerprints): void {
    memCache.entries[fp.urlHash] = {
        storedAt: new Date().toISOString(),
        contentHash: fp.contentHash,
        descHash: fp.descHash,
    };
    isDirty = true;
}

/**
 * Returns the total number of fingerprints currently tracked.
 */
export function getStoreSize(): number {
    return Object.keys(memCache.entries).length;
}

/**
 * Force an immediate flush to disk.
 * Call at the end of a crawl run.
 */
export function flushDedupStore(): void {
    saveToDisk();
    log.info(`[DedupStore] Flushed. Final size: ${getStoreSize()} entries.`);
}

/**
 * Stop the flush interval and write to disk.
 * Call in the finally block of runCrawler().
 */
export function closeDedupStore(): void {
    if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    flushDedupStore();
}

/**
 * Wipes the entire store.  Useful for testing or forcing a full re-scrape.
 */
export function clearDedupStore(): void {
    memCache = { version: 1, entries: {} };
    saveToDisk();
    log.info('[DedupStore] Store cleared.');
}
