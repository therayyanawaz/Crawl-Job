/**
 * src/maintenance.ts
 *
 * Single CLI entry-point for all storage management operations.
 *
 * USAGE
 * ──────
 *   # Archive shards older than 7 days (from .env default):
 *   npm run archive
 *
 *   # Archive shards older than 14 days:
 *   npm run archive -- --days 14
 *
 *   # Dry-run: preview what WOULD be archived (no changes):
 *   npm run archive:preview
 *
 *   # Delete archives older than 90 days (from .env default):
 *   npm run cleanup
 *
 *   # Preview deletions only:
 *   npm run cleanup:preview
 *
 *   # Upload pending archives to cloud (if configured):
 *   npm run upload
 *
 *   # Full maintenance cycle: archive → upload → cleanup:
 *   npm run maintenance
 *
 *   # Show storage usage and archive inventory:
 *   npm run archive:status
 */

import 'dotenv/config';
import { archiveOldDatasets, listArchives } from './utils/archive.js';
import { cleanupArchives, printStorageUsage } from './utils/cleanup.js';
import { uploadAllPendingArchives } from './utils/cloudUpload.js';
import { log } from 'crawlee';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? '--help';
const dryRun = args.includes('--dry-run') || args.includes('--preview');
const daysArg = (() => {
    const i = args.indexOf('--days');
    return i !== -1 && args[i + 1] ? Number(args[i + 1]) : null;
})();

// ─── Commands ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    switch (command) {
        // ── archive ─────────────────────────────────────────────────────────
        case '--archive':
        case 'archive': {
            const days = daysArg ?? Number(process.env.ARCHIVE_AFTER_DAYS ?? 7);
            log.info(`[Maintenance] Command: archive (days=${days}, dryRun=${dryRun})`);
            await archiveOldDatasets(days, dryRun);
            break;
        }

        // ── cleanup ─────────────────────────────────────────────────────────
        case '--cleanup':
        case 'cleanup': {
            const days = daysArg ?? Number(process.env.DELETE_AFTER_DAYS ?? 90);
            log.info(`[Maintenance] Command: cleanup (days=${days}, dryRun=${dryRun})`);
            await cleanupArchives(days, dryRun);
            break;
        }

        // ── upload ──────────────────────────────────────────────────────────
        case '--upload':
        case 'upload': {
            log.info('[Maintenance] Command: upload pending archives');
            await uploadAllPendingArchives();
            break;
        }

        // ── status ──────────────────────────────────────────────────────────
        case '--status':
        case 'status': {
            printStorageUsage();
            listArchives();
            break;
        }

        // ── maintenance (full cycle) ─────────────────────────────────────────
        case '--maintenance':
        case 'maintenance': {
            const archiveDays = daysArg ?? Number(process.env.ARCHIVE_AFTER_DAYS ?? 7);
            const deleteDays = Number(process.env.DELETE_AFTER_DAYS ?? 90);
            log.info(`[Maintenance] Full maintenance cycle (dry=${dryRun})`);

            // 1. Archive old hot data → warm storage
            log.info('── Phase 1: Archive old datasets');
            const archiveResult = await archiveOldDatasets(archiveDays, dryRun);

            // 2. Upload warm archives → cold cloud storage (skipped if disabled)
            log.info('── Phase 2: Upload pending archives to cloud');
            if (!dryRun) await uploadAllPendingArchives();
            else log.info('   [dry-run] Skipping upload.');

            // 3. Clean up expired archives
            log.info('── Phase 3: Cleanup expired local archives');
            const cleanupResult = await cleanupArchives(deleteDays, dryRun);

            // 4. Final status report
            log.info('── Final storage status:');
            printStorageUsage();

            log.info(
                `[Maintenance] Complete. ` +
                `Archived ${archiveResult.archivedFiles} shards (${archiveResult.totalRecords} records). ` +
                `Deleted ${cleanupResult.deletedArchives} old archives.`
            );
            break;
        }

        // ── help / unknown ───────────────────────────────────────────────────
        default: {
            console.log(`
Crawl-Job — Storage Maintenance CLI
══════════════════════════════════════

Commands:
  archive            Archive hot data older than ARCHIVE_AFTER_DAYS (default: 7)
  cleanup            Delete cold archives older than DELETE_AFTER_DAYS (default: 90)
  upload             Upload pending archives to S3-compatible cloud storage
  status             Show storage usage and archive inventory
  maintenance        Run full cycle: archive → upload → cleanup

Options:
  --days N           Override the age threshold for archive or cleanup
  --dry-run          Preview changes without modifying any files
  --preview          Alias for --dry-run

Examples:
  npm run archive                       # archive data older than .env value
  npm run archive -- --days 3           # archive anything older than 3 days
  npm run archive:preview               # dry-run first
  npm run cleanup                       # delete archives past retention
  npm run cleanup:preview               # preview deletions
  npm run maintenance                   # full cycle (archive+upload+cleanup)
  npm run archive:status                # show disk usage table
            `);
            break;
        }
    }
}

main().catch((err) => {
    log.error(`[Maintenance] Fatal error: ${err}`);
    process.exit(1);
});
