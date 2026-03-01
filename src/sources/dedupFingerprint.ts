import type { RawJobListing } from './types.js';

function normalizeToken(value: string | undefined): string {
    if (!value) return '';
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSourceSlug(source: string | undefined): string {
    return normalizeToken(source).replace(/[^a-z0-9]+/g, '-');
}

function normalizeUrl(url: string | undefined): string {
    const raw = normalizeToken(url);
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        parsed.hash = '';
        parsed.search = '';
        const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
        return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${normalizedPath}`;
    } catch {
        return raw;
    }
}

function extractUrlJobId(url: string): string {
    try {
        const parsed = new URL(url);
        const candidates = [
            parsed.searchParams.get('id'),
            parsed.searchParams.get('jobid'),
            parsed.searchParams.get('jobId'),
            parsed.searchParams.get('jk'),
            parsed.searchParams.get('vjk'),
        ].filter(Boolean) as string[];

        if (candidates.length > 0) {
            return normalizeToken(candidates[0]);
        }

        const segments = parsed.pathname.split('/').map((seg) => normalizeToken(seg)).filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : '';
    } catch {
        return '';
    }
}

export function getJobDedupId(job: Pick<RawJobListing, 'platformJobId' | 'url'>): string {
    const fromPlatform = normalizeToken(job.platformJobId);
    if (fromPlatform) return fromPlatform;
    return extractUrlJobId(job.url);
}

export function buildJobFingerprint(
    job: Pick<RawJobListing, 'source' | 'url' | 'platformJobId'>
): string {
    const sourceSlug = normalizeSourceSlug(job.source);
    const normalizedUrl = normalizeUrl(job.url);
    const jobId = getJobDedupId(job);
    return `${sourceSlug}::${normalizedUrl}::${jobId}`;
}

export function createFingerprintSet(existing: RawJobListing[] = []): Set<string> {
    const set = new Set<string>();
    for (const job of existing) {
        set.add(buildJobFingerprint(job));
    }
    return set;
}

export function addUniqueJob(
    job: RawJobListing,
    target: RawJobListing[],
    seenFingerprints: Set<string>
): boolean {
    const fp = buildJobFingerprint(job);
    if (seenFingerprints.has(fp)) {
        return false;
    }
    seenFingerprints.add(fp);
    target.push(job);
    return true;
}

export interface DedupeStats {
    uniqueJobs: RawJobListing[];
    duplicateCount: number;
    lookupCount: number;
    dedupHitRatio: number;
}

export function dedupeJobsWithStats(
    jobs: RawJobListing[],
    seedJobs: RawJobListing[] = []
): DedupeStats {
    const seen = createFingerprintSet(seedJobs);
    const uniqueJobs: RawJobListing[] = [];
    let duplicateCount = 0;
    let lookupCount = 0;

    for (const job of jobs) {
        const fp = buildJobFingerprint(job);
        lookupCount++;
        if (seen.has(fp)) {
            duplicateCount++;
            continue;
        }
        seen.add(fp);
        uniqueJobs.push(job);
    }

    return {
        uniqueJobs,
        duplicateCount,
        lookupCount,
        dedupHitRatio: jobs.length > 0 ? duplicateCount / jobs.length : 0,
    };
}
