/**
 * src/sources/types.ts
 *
 * Shared types for all job data sources across all tiers.
 *
 * SCHEMA aligned with STRATEGY.md § 7 (Output Schema).
 * Every source returns RawJobListing objects. The orchestrator normalises
 * these into the unified schema used by dedup / DB storage.
 */

// ─── Raw Job Listing ──────────────────────────────────────────────────────────

export interface RawJobListing {
    title: string;
    company: string;
    location?: string;
    description: string;
    url: string;                 // Canonical job page URL
    applyUrl?: string;           // Direct application link (may differ from url)
    salary?: string;
    jobType?: string;            // Full-time, Part-time, Internship, Contract
    experience?: string;         // "0-2 years", "Fresher", "2-5 years"
    postedDate?: string;         // "3 days ago", "2026-02-20", etc.
    seniority?: string;          // Entry level, Mid-Senior, etc.
    source: string;              // Platform key: indeed, linkedin, naukri, internshala, google_serp, jsearch
    platformJobId?: string;      // Platform's own ID (e.g., Indeed jk=, LinkedIn numeric ID)
    sourceTier?: string;         // How it was collected: rss, jsearch, direct_crawl, headless, apify
}

// ─── Source Tier ──────────────────────────────────────────────────────────────

export type SourceTier =
    | 'TIER_0'       // Zero cost: JSearch API, Indeed RSS, Google SERP
    | 'TIER_1'       // Direct crawl, no proxy: Internshala, Naukri (CheerioCrawler)
    | 'TIER_2'       // Headless + block: Indeed, LinkedIn (PlaywrightCrawler + paid proxy)
    | 'TIER_3';      // Apify actors (last resort)

// ─── Source Result ────────────────────────────────────────────────────────────

export interface SourceResult {
    source: string;
    tier: SourceTier;
    jobs: RawJobListing[];
    durationMs: number;
    error?: string;
}

// ─── Search Query ─────────────────────────────────────────────────────────────

export interface SearchQuery {
    keywords: string;       // e.g. "software developer fresher"
    location?: string;      // e.g. "India", "Bangalore", "Remote"
    maxResults?: number;    // Limit per source (default: 50)
}
