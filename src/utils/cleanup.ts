/**
 * src/utils/cleanup.ts
 *
 * Deletes local archives that have passed the cold-storage retention period.
 *
 * SAFETY MODEL
 * ─────────────
 * 1. Dry-run by default in interactive mode — always logs WHAT will be deleted
 *    before deleting anything.
 * 2. Cloud-upload guard: if CLOUD_UPLOAD_ENABLED=true, cleanup refuses to
 *    delete an archive unless the manifest records a successful upload.
 * 3. Never touches the hot dataset directory — only the archives/ subtree.
 * 4. Directories that become empty after deletion are pruned automatically.
 *
 * USAGE
 * ──────
 *   import { cleanupArchives } from './utils/cleanup.js';
 *   await cleanupArchives(90);            // delete archives older than 90 days
 *   await cleanupArchives(90, true);      // dry-run preview only
 *
 * Or via CLI:
 *   npm run cleanup           # uses DELETE_AFTER_DAYS from .env
 *   npm run cleanup:preview   # dry-run, no deletions
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from 'crawlee';
import type { ArchiveManifest } from './archive.js';
import 'dotenv/config';

// ─── Paths ────────────────────────────────────────────────────────────────────

const STORAGE_DIR = process.env.CRAWLEE_STORAGE_DIR ?? path.join(process.cwd(), 'storage');
const ARCHIVES_ROOT = path.join(STORAGE_DIR, 'archives');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CleanupCandidate {
    archivePath: string;
    manifestPath: string;
    ageInDays: number;
    sizeBytes: number;
    totalRecords: number;
    uploadedAt: string | null;
}

export interface CleanupResult {
    deletedArchives: number;
    skippedByAge: number;
    skippedByUpload: number;
    freedBytes: number;
    errors: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

/** Recursively walks the archives tree and returns all .tar.gz file paths. */
function findArchives(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findArchives(full));
        else if (entry.isFile() && entry.name.endsWith('.tar.gz')) results.push(full);
    }
    return results;
}

/** Returns true if a path is an empty directory. */
function isDirEmpty(dir: string): boolean {
    try { return fs.readdirSync(dir).length === 0; }
    catch { return false; }
}

/** Removes leaf directories upward until reaching the archives root. */
function pruneEmptyParents(startDir: string): void {
    let current = startDir;
    while (current.startsWith(ARCHIVES_ROOT) && current !== ARCHIVES_ROOT) {
        if (isDirEmpty(current)) {
            fs.rmdirSync(current);
            log.debug(`[Cleanup] Removed empty dir: ${path.relative(process.cwd(), current)}`);
            current = path.dirname(current);
        } else {
            break;
        }
    }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Deletes local archives older than `retentionDays`.
 *
 * @param retentionDays  Archives older than this are candidates for deletion.
 * @param dryRun         If true, log what would be deleted without touching disk.
 */
export async function cleanupArchives(
    retentionDays: number = Number(process.env.DELETE_AFTER_DAYS ?? 90),
    dryRun = false
): Promise<CleanupResult> {
    const cloudGuard = process.env.CLOUD_UPLOAD_ENABLED === 'true';
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    log.info(
        `[Cleanup] Scanning archives older than ${retentionDays} day(s)` +
        (cloudGuard ? ' (cloud-upload guard ON)' : '') +
        (dryRun ? ' [DRY-RUN]' : '') +
        '…'
    );

    const allArchives = findArchives(ARCHIVES_ROOT);

    if (allArchives.length === 0) {
        log.info('[Cleanup] No archives found. Nothing to do.');
        return { deletedArchives: 0, skippedByAge: 0, skippedByUpload: 0, freedBytes: 0, errors: 0 };
    }

    // Build candidate list
    const candidates: CleanupCandidate[] = [];

    for (const archivePath of allArchives) {
        const stat = fs.statSync(archivePath);
        const ageInDays = (Date.now() - stat.mtimeMs) / 86_400_000;
        const manifestPath = archivePath.replace('.tar.gz', '.manifest.json');

        let totalRecords = 0;
        let uploadedAt: string | null = null;

        if (fs.existsSync(manifestPath)) {
            try {
                const m: ArchiveManifest & { uploadedAt?: string } =
                    JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                totalRecords = m.totalRecords;
                uploadedAt = m.uploadedAt ?? null;
            } catch { /* malformed manifest — treat upload as unknown */ }
        }

        candidates.push({
            archivePath,
            manifestPath,
            ageInDays: Math.round(ageInDays * 10) / 10,
            sizeBytes: stat.size,
            totalRecords,
            uploadedAt,
        });
    }

    // Sort oldest first
    candidates.sort((a, b) => b.ageInDays - a.ageInDays);

    const result: CleanupResult = {
        deletedArchives: 0,
        skippedByAge: 0,
        skippedByUpload: 0,
        freedBytes: 0,
        errors: 0,
    };

    // Print preview table
    console.log('\n┌────────────────────────────────────────────────┬───────────┬──────────┬────────────┬─────────────┐');
    console.log('│ Archive                                        │ Age (d)   │ Size     │ Records    │ Action      │');
    console.log('├────────────────────────────────────────────────┼───────────┼──────────┼────────────┼─────────────┤');

    for (const c of candidates) {
        const relPath = path.relative(process.cwd(), c.archivePath);
        const shortName = relPath.slice(-46).padEnd(46);
        const age = String(c.ageInDays).padEnd(9);
        const size = humanSize(c.sizeBytes).padEnd(8);
        const records = String(c.totalRecords).padEnd(10);

        let action: string;

        if (c.ageInDays < retentionDays) {
            action = 'KEEP (too new)';
            result.skippedByAge++;
        } else if (cloudGuard && !c.uploadedAt) {
            action = 'SKIP (not uploaded)';
            result.skippedByUpload++;
        } else {
            action = dryRun ? 'WOULD DELETE' : 'DELETE';
        }

        console.log(`│ ${shortName} │ ${age} │ ${size} │ ${records} │ ${action.padEnd(11)} │`);
    }

    console.log('└────────────────────────────────────────────────┴───────────┴──────────┴────────────┴─────────────┘\n');

    if (dryRun) {
        const eligible = candidates.filter(
            (c) => c.ageInDays >= retentionDays && (!cloudGuard || c.uploadedAt)
        );
        const freedBytes = eligible.reduce((s, c) => s + c.sizeBytes, 0);
        log.info(
            `[Cleanup] DRY-RUN complete. Would delete ${eligible.length} archive(s) ` +
            `freeing ${humanSize(freedBytes)}.`
        );
        return result;
    }

    // Perform deletions
    for (const c of candidates) {
        if (c.ageInDays < retentionDays) continue;
        if (cloudGuard && !c.uploadedAt) continue;

        try {
            // Delete the .tar.gz
            fs.unlinkSync(c.archivePath);

            // Delete the companion manifest
            if (fs.existsSync(c.manifestPath)) {
                fs.unlinkSync(c.manifestPath);
            }

            // Remove now-empty parent directories (YYYY/MM)
            pruneEmptyParents(path.dirname(c.archivePath));

            result.deletedArchives++;
            result.freedBytes += c.sizeBytes;

            log.info(
                `[Cleanup] Deleted ${path.relative(process.cwd(), c.archivePath)} ` +
                `(${humanSize(c.sizeBytes)}, ${c.totalRecords} records, ` +
                `${c.ageInDays}d old).`
            );
        } catch (err: any) {
            log.error(`[Cleanup] Failed to delete ${c.archivePath}: ${err.message}`);
            result.errors++;
        }
    }

    log.info(
        `[Cleanup] Done. Deleted: ${result.deletedArchives} archives | ` +
        `Freed: ${humanSize(result.freedBytes)} | ` +
        `Skipped (too new): ${result.skippedByAge} | ` +
        `Skipped (not uploaded): ${result.skippedByUpload} | ` +
        `Errors: ${result.errors}.`
    );

    return result;
}

/**
 * Shows current disk usage of hot and warm storage tiers.
 * Call via: npm run archive:status
 */
export function printStorageUsage(): void {
    const DATASET_DIR = path.join(STORAGE_DIR, 'datasets', 'default');

    const dirSizeBytes = (dir: string): number => {
        if (!fs.existsSync(dir)) return 0;
        let total = 0;
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) total += dirSizeBytes(full);
            else try { total += fs.statSync(full).size; } catch { /* skip */ }
        }
        return total;
    };

    const hotBytes = dirSizeBytes(DATASET_DIR);
    const archBytes = dirSizeBytes(ARCHIVES_ROOT);
    const totalBytes = hotBytes + archBytes;

    const archiveCount = findArchives(ARCHIVES_ROOT).length;

    console.log('\n  Storage Tiers');
    console.log('  ─────────────────────────────────────────');
    console.log(`  Hot  (datasets/default/):  ${humanSize(hotBytes).padEnd(10)} [live data]`);
    console.log(`  Warm (archives/):           ${humanSize(archBytes).padEnd(10)} [${archiveCount} archives]`);
    console.log(`  Total:                      ${humanSize(totalBytes)}`);
    console.log('');
}
