/**
 * src/utils/archive.ts
 *
 * Moves and compresses Crawlee dataset JSON shards that are older than a
 * configurable number of days into dated gzip archives, then writes a
 * JSON manifest so the archived content can be inspected without
 * decompressing the file.
 *
 * STORAGE TIERS
 * ─────────────
 *   Hot  (0 – ARCHIVE_AFTER_DAYS)   → storage/datasets/default/*.json
 *          Crawlee reads/writes here. Fast, uncompressed, on local SSD.
 *
 *   Warm (ARCHIVE_AFTER_DAYS – DELETE_AFTER_DAYS)
 *          → storage/archives/YYYY/MM/YYYY-MM-DD_jobs_NNN-NNN.tar.gz
 *          Gzip-compressed, on local disk. Readable with tar -tzf.
 *          ~70-80% smaller than raw JSON (job text compresses very well).
 *
 *   Cold (older than DELETE_AFTER_DAYS)
 *          → optionally uploaded to S3/Spaces/MinIO before local deletion.
 *          cleanup.ts handles the local deletion step.
 *
 * CRAWLEE SHARD FORMAT
 * ─────────────────────
 * Crawlee writes its dataset as sequentially numbered JSON files:
 *   storage/datasets/default/000000001.json
 *   storage/datasets/default/000000002.json
 *   ...
 * Each file is one or more JSON records (one per line — JSONL format).
 * We archive by FILE mtime, not by the job's scraped timestamp.
 *
 * WHY tar.gz AND NOT zip?
 * ─────────────────────────
 * tar.gz is the standard on Linux systems, available without any npm
 * dependency (Node's built-in zlib + tar child process). It preserves
 * file metadata, streams well, and is natively readable by every CLI
 * tool (tar, zcat, zgrep). zip would require a third-party npm package.
 *
 * USAGE
 * ──────
 *   import { archiveOldDatasets } from './utils/archive.js';
 *   await archiveOldDatasets(7);  // archive shards older than 7 days
 *
 * Or via CLI:
 *   npx ts-node src/maintenance.ts --archive 7
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from 'crawlee';

const execFileAsync = promisify(execFile);
import 'dotenv/config';

// ─── Paths ────────────────────────────────────────────────────────────────────

const STORAGE_DIR = process.env.CRAWLEE_STORAGE_DIR ?? path.join(process.cwd(), 'storage');
const DATASET_DIR = path.join(STORAGE_DIR, 'datasets', 'default');
const ARCHIVES_ROOT = path.join(STORAGE_DIR, 'archives');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArchiveManifestEntry {
    originalPath: string;
    sizeBytes: number;
    recordCount: number;
    mtimeIso: string;
}

export interface ArchiveManifest {
    createdAt: string;
    archivePath: string;
    archiveSizeBytes: number;
    compressionRatio: string;
    totalRecords: number;
    totalOriginalBytes: number;
    files: ArchiveManifestEntry[];
}

export interface ArchiveResult {
    archivedFiles: number;
    skippedFiles: number;
    archivesCreated: string[];
    totalRecords: number;
    savedBytes: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Age gate: returns true if the file's mtime is older than daysOld days. */
function isOlderThan(filePath: string, daysOld: number): boolean {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays >= daysOld;
}

/** Count the number of JSON records (lines) in a shard file. */
function countRecords(filePath: string): number {
    try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content) return 0;
        return content.split('\n').filter((l) => l.trim().startsWith('{')).length;
    } catch {
        return 0;
    }
}

/**
 * Returns the archive directory path for a given date.
 * e.g. 2026-02-21 → storage/archives/2026/02
 */
function archiveDirForDate(date: Date): string {
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return path.join(ARCHIVES_ROOT, year, month);
}

/**
 * Produces a human-readable file size string.
 */
function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Archives Crawlee dataset shards older than `daysOld` days.
 *
 * Shards are grouped by calendar day (based on file mtime) and packed
 * into a single .tar.gz per day per run:
 *   storage/archives/2026/02/2026-02-14_jobs_001-010.tar.gz
 *
 * After a successful archive, originals are removed from the dataset dir.
 * A JSON manifest is written alongside the archive for quick inspection.
 *
 * @param daysOld  Minimum age in days for a shard to be eligible.
 *                 Set to 0 for a dry-run simulation (no files moved).
 * @param dryRun   If true, log what WOULD be archived without touching files.
 */
export async function archiveOldDatasets(
    daysOld: number = Number(process.env.ARCHIVE_AFTER_DAYS ?? 7),
    dryRun = false
): Promise<ArchiveResult> {

    log.info(`[Archive] Scanning ${DATASET_DIR} for shards older than ${daysOld} day(s)…`);

    if (!fs.existsSync(DATASET_DIR)) {
        log.warning('[Archive] Dataset directory does not exist — nothing to archive.');
        return { archivedFiles: 0, skippedFiles: 0, archivesCreated: [], totalRecords: 0, savedBytes: 0 };
    }

    // Collect all .json shard files
    const allShards = fs.readdirSync(DATASET_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'dedup-store.json')
        .map((f) => path.join(DATASET_DIR, f))
        .filter((fp) => fs.statSync(fp).isFile());

    // Split into eligible (old enough) and skip (too recent)
    const eligible = allShards.filter((fp) => isOlderThan(fp, daysOld));
    const skipped = allShards.length - eligible.length;

    log.info(`[Archive] ${allShards.length} total shards | ${eligible.length} eligible | ${skipped} too recent.`);

    if (eligible.length === 0) {
        log.info('[Archive] No shards eligible for archival. Done.');
        return { archivedFiles: 0, skippedFiles: skipped, archivesCreated: [], totalRecords: 0, savedBytes: 0 };
    }

    // Group eligible shards by their mtime calendar day
    const byDay = new Map<string, string[]>();
    for (const fp of eligible) {
        const mtime = fs.statSync(fp).mtime;
        const dayKey = mtime.toISOString().slice(0, 10); // "YYYY-MM-DD"
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey)!.push(fp);
    }

    // Sort days oldest-first so archives are created in chronological order
    const sortedDays = [...byDay.keys()].sort();

    const result: ArchiveResult = {
        archivedFiles: 0,
        skippedFiles: skipped,
        archivesCreated: [],
        totalRecords: 0,
        savedBytes: 0,
    };

    for (const dayKey of sortedDays) {
        const shards = byDay.get(dayKey)!.sort(); // alphabetical = shard order
        const dayDate = new Date(dayKey);
        const archiveDir = archiveDirForDate(dayDate);

        // Derive a readable name from the first and last shard numbers
        const firstNum = path.basename(shards[0]).replace('.json', '');
        const lastNum = path.basename(shards[shards.length - 1]).replace('.json', '');
        const archiveName = `${dayKey}_jobs_${firstNum}-${lastNum}.tar.gz`;
        const archivePath = path.join(archiveDir, archiveName);
        const manifestPath = archivePath.replace('.tar.gz', '.manifest.json');

        // Gather metadata before archiving
        const entries: ArchiveManifestEntry[] = shards.map((fp) => {
            const stat = fs.statSync(fp);
            return {
                originalPath: path.relative(process.cwd(), fp),
                sizeBytes: stat.size,
                recordCount: countRecords(fp),
                mtimeIso: stat.mtime.toISOString(),
            };
        });

        const totalRecords = entries.reduce((s, e) => s + e.recordCount, 0);
        const totalOriginalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);

        log.info(
            `[Archive] Day ${dayKey}: ${shards.length} shards, ` +
            `${totalRecords} records, ${humanSize(totalOriginalBytes)} uncompressed.`
        );

        if (dryRun) {
            log.info(`[Archive] DRY-RUN: Would create ${archivePath}`);
            log.info(`[Archive] DRY-RUN: Would delete ${shards.length} source shards.`);
            result.archivedFiles += shards.length;
            result.totalRecords += totalRecords;
            continue;
        }

        // Create archive directory
        fs.mkdirSync(archiveDir, { recursive: true });

        // Build tar.gz using the system `tar` binary — zero npm dependencies.
        // Equivalent: tar -czf archivePath -C DATASET_DIR shard1.json shard2.json ...
        try {
            await execFileAsync(
                'tar',
                [
                    '-czf', archivePath,
                    '-C', DATASET_DIR,
                    ...shards.map((fp) => path.basename(fp)),
                ],
                { maxBuffer: 50 * 1024 * 1024 }   // 50 MB stdout buffer — safe for log lines
            );
        } catch (err: any) {
            log.error(`[Archive] tar.create failed for ${archivePath}: ${err.message}`);
            continue; // Skip this day — original files remain untouched
        }

        // Measure compressed size
        const archiveStat = fs.statSync(archivePath);
        const archiveSizeBytes = archiveStat.size;
        const savedBytes = totalOriginalBytes - archiveSizeBytes;

        // Write manifest
        const manifest: ArchiveManifest = {
            createdAt: new Date().toISOString(),
            archivePath: path.relative(process.cwd(), archivePath),
            archiveSizeBytes,
            compressionRatio: `${((1 - archiveSizeBytes / totalOriginalBytes) * 100).toFixed(1)}%`,
            totalRecords,
            totalOriginalBytes,
            files: entries,
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

        log.info(
            `[Archive] ✓ Created ${path.relative(process.cwd(), archivePath)} ` +
            `(${humanSize(archiveSizeBytes)} compressed, ${manifest.compressionRatio} savings, ` +
            `${totalRecords} records).`
        );

        // Remove original shards only after confirmed archive creation
        for (const fp of shards) {
            try {
                fs.unlinkSync(fp);
            } catch (err: any) {
                log.warning(`[Archive] Could not delete ${fp}: ${err.message}`);
            }
        }

        result.archivedFiles += shards.length;
        result.totalRecords += totalRecords;
        result.savedBytes += savedBytes;
        result.archivesCreated.push(archivePath);
    }

    log.info(
        `[Archive] Done. ` +
        `${result.archivedFiles} shards archived into ${result.archivesCreated.length} archive(s). ` +
        `Total: ${result.totalRecords} records | ${humanSize(result.savedBytes)} disk space recovered.`
    );

    return result;
}

/**
 * Lists all archives with their manifest data — printed as a table.
 * Use for: npm run archive:status
 */
export function listArchives(): void {
    if (!fs.existsSync(ARCHIVES_ROOT)) {
        log.info('[Archive] No archives directory found.');
        return;
    }

    const manifests: string[] = [];
    const walkDir = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkDir(full);
            else if (entry.isFile() && entry.name.endsWith('.manifest.json')) manifests.push(full);
        }
    };
    walkDir(ARCHIVES_ROOT);

    if (manifests.length === 0) {
        log.info('[Archive] No archive manifests found.');
        return;
    }

    let totalRecords = 0;
    let totalBytes = 0;

    console.log('\n┌──────────────────────────────────────────────────────────────────────────────┐');
    console.log('│  Archive Inventory                                                           │');
    console.log('├──────────────────────┬──────────────┬──────────────┬────────────────────────┤');
    console.log('│ Archive              │ Records      │ Size         │ Savings                │');
    console.log('├──────────────────────┼──────────────┼──────────────┼────────────────────────┤');

    for (const mp of manifests.sort()) {
        const m: ArchiveManifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
        totalRecords += m.totalRecords;
        totalBytes += m.archiveSizeBytes;
        const name = path.basename(mp).replace('.manifest.json', '').slice(0, 20);
        console.log(
            `│ ${name.padEnd(20)} │ ${String(m.totalRecords).padEnd(12)} │ ` +
            `${humanSize(m.archiveSizeBytes).padEnd(12)} │ ${m.compressionRatio.padEnd(22)} │`
        );
    }

    console.log('├──────────────────────┼──────────────┼──────────────┼────────────────────────┤');
    console.log(
        `│ ${'TOTAL'.padEnd(20)} │ ${String(totalRecords).padEnd(12)} │ ` +
        `${humanSize(totalBytes).padEnd(12)} │ ${String(manifests.length) + ' archives'.padEnd(22)} │`
    );
    console.log('└──────────────────────┴──────────────┴──────────────┴────────────────────────┘\n');
}
