/**
 * src/orchestrator.ts
 *
 * TIERED JOB SCRAPING ORCHESTRATOR
 *
 * Executes job data collection in a strict cascade:
 *
 *   TIER 1 (PRIMARY)    → Google Jobs SERP (HTTP + Cheerio)
 *   TIER 2 (SECONDARY)  → JSearch API (REST API)
 *   TIER 3 (TERTIARY)   → Indeed RSS, Internshala HTTP, Naukri HTTP
 *   TIER 4 (QUATERNARY) → Indeed + LinkedIn headless (Playwright)
 *                         Only activated when:
 *                           a) Tiers 1-3 yield fewer than MIN_JOBS_BEFORE_HEADLESS
 *                           b) OR the proxy is a paid/residential proxy (always safe)
 *
 * PROXY-AWARE STRATEGY
 * ─────────────────────
 * - With PAID proxies → Tier 4 headless runs aggressively (higher concurrency,
 *   browser fingerprinting, full resource blocking for speed).
 * - With FREE proxies → Tier 4 runs conservatively or is skipped entirely to
 *   avoid triggering Akamai/Datadome blocks that waste free proxy bandwidth.
 *
 * All tiers feed into the same dedup + Zod validation + DB pipeline.
 */

import { log, Dataset } from 'crawlee';
import { z } from 'zod';
import { isDuplicateJob, markJobAsStored } from './utils/dedup.js';
import { saveJobToDb } from './utils/jobStore.js';
import type { StorableJob } from './utils/jobStore.js';
import { enqueuePersistenceTask } from './utils/persistenceQueue.js';
import { runJobsParallel } from './utils/jobBatchRunner.js';
import { decideHeadlessLaunch, resolveHeadlessSkipThreshold } from './utils/headlessDecision.js';
import {
    recordJobDeduplicated,
    recordJobExtracted,
    recordJobPersistenceFailed,
    recordJobStored,
} from './utils/metrics.js';

// ── Source imports
import { fetchSerperJobs } from './sources/serperApi.js';
import { fetchJobicyRss } from './sources/jobicyRss.js';
import { fetchIndeedRss } from './sources/indeedRss.js';
import { fetchInternshalaJobs } from './sources/internshalaHttp.js';
import { fetchNaukriJobs } from './sources/naukriHttp.js';

import type { RawJobListing, SearchQuery, SourceResult, SourceTier } from './sources/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Minimum combined job count before we skip headless (Tier 2). */
const MIN_JOBS_BEFORE_HEADLESS = Number(process.env.MIN_JOBS_BEFORE_HEADLESS ?? 15);
const HEADLESS_SKIP_THRESHOLD = resolveHeadlessSkipThreshold(process.env.HEADLESS_SKIP_THRESHOLD, 25);

// ─── Zod Schema (aligned with STRATEGY.md § 7) ───────────────────────────────

const JobSchema = z.object({
    url: z.string().url(),
    title: z.string().min(2),
    company: z.string().default('Unknown Company'),
    description: z.string().min(10),
    location: z.string().optional(),
    postedDate: z.string().optional(),
    jobType: z.string().optional(),
    salary: z.string().optional(),
    experience: z.string().optional(),
    seniority: z.string().optional(),
    source: z.string().optional(),
    platform: z.string().optional(),
    platformJobId: z.string().optional(),
    applyUrl: z.string().optional(),
    sourceTier: z.string().optional(),
    scrapedAt: z.string().datetime(),
});

type JobRecord = z.infer<typeof JobSchema>;

// ─── Job Save Pipeline ────────────────────────────────────────────────────────

async function saveJobFromSource(raw: RawJobListing, dataset: Dataset): Promise<boolean> {
    const withTimestamp = {
        ...raw,
        scrapedAt: new Date().toISOString(),
        platform: raw.source,
        sourceTier: raw.sourceTier ?? 'direct_crawl',
    };

    let clean: JobRecord;
    try {
        clean = JobSchema.parse(withTimestamp);
    } catch (err) {
        log.debug(`[Orchestrator] Validation failed for "${raw.title}": ${err}`);
        return false;
    }
    recordJobExtracted();

    const { isDuplicate, reason } = await isDuplicateJob(clean);
    if (isDuplicate) {
        recordJobDeduplicated();
        log.debug(`[Orchestrator] DUPLICATE (${reason}): "${clean.title}" @ "${clean.company}"`);
        return false;
    }

    try {
        await dataset.pushData(clean);
        enqueuePersistenceTask(async () => {
            try {
                await markJobAsStored(clean);
                const insertedId = await saveJobToDb(clean as unknown as StorableJob);
                if (insertedId !== null) {
                    recordJobStored();
                } else {
                    recordJobPersistenceFailed();
                }
            } catch {
                recordJobPersistenceFailed();
                throw new Error(`[Orchestrator] Persistence failed for "${clean.title}" @ "${clean.company}"`);
            }
        });
        log.info(`[Orchestrator] ✓ Stored [${clean.source}]: "${clean.title}" @ "${clean.company}"`);
        return true;
    } catch (err) {
        log.error(`[Orchestrator] pushData failed: ${err}`);
        return false;
    }
}

// ─── Tier Execution Helpers ───────────────────────────────────────────────────

async function runTier(
    tierName: string,
    tier: SourceTier,
    fetchers: Array<() => Promise<SourceResult>>
): Promise<{ results: SourceResult[]; totalJobs: number }> {
    log.info(`\n${'═'.repeat(60)}`);
    log.info(`  TIER: ${tierName} (${tier})`);
    log.info(`${'═'.repeat(60)}`);

    const results: SourceResult[] = [];

    const promises = fetchers.map(fn => fn().catch((err: any): SourceResult => ({
        source: 'unknown',
        tier,
        jobs: [],
        durationMs: 0,
        error: err.message,
    })));

    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
        if (result.status === 'fulfilled') {
            results.push(result.value);
        }
    }

    const totalJobs = results.reduce((sum, r) => sum + r.jobs.length, 0);

    for (const r of results) {
        const status = r.error ? `✗ ERROR: ${r.error}` : `✓ ${r.jobs.length} jobs`;
        log.info(`  [${r.source}] ${status} (${r.durationMs}ms)`);
    }
    log.info(`  → Tier total: ${totalJobs} raw jobs`);

    return { results, totalJobs };
}

async function processTierResultsParallel(
    results: SourceResult[],
    dataset: Dataset
): Promise<{ stored: number; duplicates: number }> {
    // Ordering between jobs is not required for correctness: dedup + persistence are idempotent.
    const jobs = results.flatMap((result) => result.jobs);
    const run = await runJobsParallel(jobs, (job) => saveJobFromSource(job, dataset));
    return {
        stored: run.stored,
        duplicates: run.skipped,
    };
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

export interface OrchestratorResult {
    totalStored: number;
    totalDuplicatesSkipped: number;
    totalValidationFailed: number;
    tierBreakdown: Record<string, { raw: number; stored: number }>;
    headlessNeeded: boolean;
    jobsCollectedBeforeHeadless: number;
    headlessSkipThreshold: number;
    durationMs: number;
}

/**
 * Runs the full tiered job collection pipeline.
 *
 * @param queries      Array of search queries to run across all sources
 * @param hasPaidProxy Whether the active proxy pool is a paid/residential service
 * @returns            Summary report of what was collected
 */
export async function runOrchestrator(
    queries: SearchQuery[],
    hasPaidProxy: boolean = false
): Promise<OrchestratorResult> {
    const orchestratorStart = Date.now();
    const dataset = await Dataset.open();

    let totalStored = 0;
    let totalDuplicatesSkipped = 0;
    let totalValidationFailed = 0;
    const tierBreakdown: Record<string, { raw: number; stored: number }> = {};

    log.info('\n' + '█'.repeat(60));
    log.info('  JOB SCRAPING ORCHESTRATOR — TIERED EXECUTION');
    log.info('  Queries: ' + queries.map(q => `"${q.keywords}"`).join(', '));
    log.info('  Proxy:   ' + (hasPaidProxy ? 'PAID ✓ (Headless enabled)' : 'FREE/UNKNOWN (Headless conditional)'));
    log.info('█'.repeat(60));

    // ── TIER 1: Serper API (PRIMARY — always runs) ──────────────────────
    const tier1Fetchers = queries.map(q => () => fetchSerperJobs(q));
    const tier1 = await runTier('Serper.dev API', 'TIER_0', tier1Fetchers);

    const tier1Persist = await processTierResultsParallel(tier1.results, dataset);
    const tier1stored = tier1Persist.stored;
    totalStored += tier1Persist.stored;
    totalDuplicatesSkipped += tier1Persist.duplicates;
    tierBreakdown['serper_api'] = { raw: tier1.totalJobs, stored: tier1stored };

    // ── TIER 2: Jobicy RSS (SECONDARY — always runs as supplement) ────────────
    const tier2Fetchers = queries.map(q => () => fetchJobicyRss(q));
    const tier2 = await runTier('Jobicy RSS', 'TIER_0', tier2Fetchers);

    const tier2Persist = await processTierResultsParallel(tier2.results, dataset);
    const tier2stored = tier2Persist.stored;
    totalStored += tier2Persist.stored;
    totalDuplicatesSkipped += tier2Persist.duplicates;
    tierBreakdown['jobicy_rss'] = { raw: tier2.totalJobs, stored: tier2stored };

    // ── TIER 3: RSS + HTTP sources (TERTIARY — run in parallel) ───────────────
    const tier3Fetchers: Array<() => Promise<SourceResult>> = [];
    for (const q of queries) {
        tier3Fetchers.push(
            () => fetchIndeedRss(q),
            () => fetchInternshalaJobs(q),
            () => fetchNaukriJobs(q),
        );
    }
    const tier3 = await runTier('RSS & HTTP Sources', 'TIER_1', tier3Fetchers);

    const tier3Persist = await processTierResultsParallel(tier3.results, dataset);
    const tier3stored = tier3Persist.stored;
    totalStored += tier3Persist.stored;
    totalDuplicatesSkipped += tier3Persist.duplicates;
    tierBreakdown['indeed_rss'] = {
        raw: tier3.results.filter(r => r.source === 'indeed_rss').reduce((s, r) => s + r.jobs.length, 0),
        stored: 0,
    };
    tierBreakdown['internshala'] = {
        raw: tier3.results.filter(r => r.source === 'internshala').reduce((s, r) => s + r.jobs.length, 0),
        stored: 0,
    };
    tierBreakdown['naukri'] = {
        raw: tier3.results.filter(r => r.source === 'naukri').reduce((s, r) => s + r.jobs.length, 0),
        stored: 0,
    };

    // ── TIER 4 DECISION: Do we need headless? ─────────────────────────────────
    const combinedBeforeHeadless = totalStored;
    const effectiveSkipThreshold = Math.max(MIN_JOBS_BEFORE_HEADLESS, HEADLESS_SKIP_THRESHOLD);
    const launchDecision = decideHeadlessLaunch(combinedBeforeHeadless, effectiveSkipThreshold);
    const headlessNeeded = launchDecision.shouldLaunch;
    if (launchDecision.partialCollection) {
        log.warning(
            `[Orchestrator] Partial API collection (${launchDecision.preCollectedJobs}/${launchDecision.threshold}). ` +
            'Launching headless fallback.'
        );
    }

    log.info(`\n${'─'.repeat(60)}`);
    log.info(`  HEADLESS DECISION`);
    log.info(`  Jobs stored so far : ${combinedBeforeHeadless}`);
    log.info(`  Minimum threshold  : ${MIN_JOBS_BEFORE_HEADLESS}`);
    log.info(`  Skip threshold     : ${effectiveSkipThreshold}`);
    log.info(`  Paid proxy         : ${hasPaidProxy ? 'YES' : 'NO'}`);
    log.info(`  Decision reason    : ${launchDecision.reason}`);
    log.info(`  Headless needed    : ${headlessNeeded ? 'YES — activating Tier 4' : 'NO — skip Tier 4'}`);
    log.info(`${'─'.repeat(60)}`);

    // ── Final Summary ─────────────────────────────────────────────────────────
    const durationMs = Date.now() - orchestratorStart;

    log.info(`\n${'█'.repeat(60)}`);
    log.info(`  ORCHESTRATOR COMPLETE`);
    log.info(`  Total stored:     ${totalStored}`);
    log.info(`  Duplicates:       ${totalDuplicatesSkipped}`);
    log.info(`  Duration:         ${(durationMs / 1000).toFixed(1)}s`);
    log.info(`  Headless needed:  ${headlessNeeded}`);
    log.info(`${'█'.repeat(60)}\n`);

    return {
        totalStored,
        totalDuplicatesSkipped,
        totalValidationFailed,
        tierBreakdown,
        headlessNeeded,
        jobsCollectedBeforeHeadless: combinedBeforeHeadless,
        headlessSkipThreshold: effectiveSkipThreshold,
        durationMs,
    };
}
