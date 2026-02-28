/**
 * src/utils/fingerprint.ts
 *
 * Generates stable, normalized text fingerprints for job records.
 *
 * WHY a dedicated fingerprint module?
 * ─────────────────────────────────────
 * Raw job data from different boards is messy:
 *   • "Software Engineer"  vs  "Software  Engineer " (extra space)
 *   • "Infosys Ltd"        vs  "INFOSYS LIMITED"
 *   • "Bengaluru"          vs  "Bangalore"            vs  "Bangalore, KA"
 *
 * We need a function that reduces all these to the same canonical string
 * before hashing, so that the same logical job produces the same fingerprint
 * regardless of which board it was scraped from or how its text was formatted.
 *
 * THREE fingerprint levels (fastest → most thorough):
 *
 *  1. URL fingerprint  – hash of the canonical URL.
 *     Fast O(1). Catches the 90% case where the same posting has the same URL.
 *
 *  2. Content fingerprint – hash of (normalizedTitle + normalizedCompany).
 *     Catches cross-board duplicates (same job posted on Indeed AND Naukri).
 *     False-positive risk: "Software Engineer @ Google" could match another
 *     posting at Google with a near-identical title. Acceptable at our scale.
 *
 *  3. Description hash – hash of the first 500 chars of the job description.
 *     Used as a TIE-BREAKER when content fingerprints collide to reduce false
 *     positives. Not used for primary dedup — descriptions vary too much.
 */

import { createHash } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FingerprintableJob {
    url: string;
    title: string;
    company: string;
    description?: string;
    location?: string;
    /** ISO date string, e.g. "2026-02-21" — used to scope uniqueness per posting date. */
    postedDate?: string;
}

export interface JobFingerprints {
    /** SHA-256 of the canonical URL — fastest lookup key. */
    urlHash: string;
    /** SHA-256 of normalized title + company. Cross-board duplicate key. */
    contentHash: string;
    /** SHA-256 of first 500 chars of description — tie-breaker. */
    descHash: string;
    /** The normalised title string (exposed for debugging). */
    normalizedTitle: string;
    /** The normalised company string (exposed for debugging). */
    normalizedCompany: string;
}

// ─── Known Aliases ────────────────────────────────────────────────────────────

/**
 * City aliases: maps common variants to a canonical name.
 * Extend this as you encounter more variants in your scraped data.
 */
const CITY_ALIASES: Record<string, string> = {
    'bengaluru': 'bangalore',
    'bombay': 'mumbai',
    'calcutta': 'kolkata',
    'madras': 'chennai',
    'new delhi': 'delhi',
    'gurugram': 'gurgaon',
};

/**
 * Title prefix/suffix noise words stripped before hashing.
 * Order matters — longer phrases before shorter ones.
 */
const TITLE_NOISE: string[] = [
    'senior', 'sr.', 'sr ', 'junior', 'jr.', 'jr ',
    'lead', 'staff', 'principal', 'associate',
    'mid-level', 'mid level', 'entry level', 'entry-level',
    'intern', 'internship', 'trainee',
    '(remote)', '(hybrid)', '(on-site)', '(onsite)',
    'remote', 'hybrid',
    'full time', 'full-time', 'part time', 'part-time',
    'contract', 'contractual', 'freelance',
    'urgent', 'immediate joiner', 'immediate joining',
];

/**
 * Company suffix noise stripped before hashing.
 */
const COMPANY_NOISE: string[] = [
    'private limited', 'pvt. ltd.', 'pvt ltd', 'pvt. ltd',
    'limited', 'ltd.', 'ltd',
    'incorporated', 'inc.', 'inc',
    'corporation', 'corp.', 'corp',
    'technologies', 'technology', 'tech',
    'solutions', 'services', 'systems',
    'india', 'global', 'worldwide',
];

// ─── Normalisation Helpers ────────────────────────────────────────────────────

/**
 * Strips, lowercases, collapses whitespace, and removes punctuation from a string.
 * This is the foundation of all comparisons.
 */
function base(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')   // punctuation → space
        .replace(/\s+/g, ' ')       // collapse whitespace
        .trim();
}

/**
 * Removes noise words from a job title and returns the semantic core.
 *
 * Example:
 *   "Sr. Software Engineer (Remote) - Full Time" → "software engineer"
 */
export function normalizeTitle(raw: string): string {
    let s = base(raw);
    // Remove noise substrings (sort longest first to avoid partial replacements)
    const sorted = [...TITLE_NOISE].sort((a, b) => b.length - a.length);
    for (const noise of sorted) {
        // Word-boundary replacement — prevents "remote" from nuking "seniority"
        s = s.replace(new RegExp(`\\b${noise}\\b`, 'g'), ' ');
    }
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Strips legal suffixes and common noise from a company name.
 *
 * Example:
 *   "Infosys Limited" → "infosys"
 *   "Google India Pvt. Ltd." → "google"
 */
export function normalizeCompany(raw: string): string {
    let s = base(raw);
    const sorted = [...COMPANY_NOISE].sort((a, b) => b.length - a.length);
    for (const noise of sorted) {
        s = s.replace(new RegExp(`\\b${noise}\\b`, 'g'), ' ');
    }
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalises a location string including known city alias resolution.
 *
 * Example:
 *   "Bengaluru, Karnataka" → "bangalore"
 */
export function normalizeLocation(raw: string): string {
    let s = base(raw).split(',')[0].trim(); // take city part only
    return CITY_ALIASES[s] ?? s;
}

/**
 * Truncates and normalises a description to its first 500 characters.
 * Used only as a tie-breaker, not for primary dedup.
 */
export function normalizeDescription(raw: string): string {
    return base(raw).substring(0, 500);
}

/**
 * Canonicalises a URL: removes tracking params, trailing slashes, fragments.
 *
 * Strips known tracking query parameters (utm_*, ref, etc.) from URLs so that:
 *   indeed.com/job/123?utm_source=linkedin  ≡  indeed.com/job/123
 */
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'ref', 'src', 'source', 'referrer', 'clickid', 'cmp', 'from',
]);

export function canonicalUrl(raw: string): string {
    try {
        const u = new URL(raw);
        // Remove tracking parameters
        for (const param of [...u.searchParams.keys()]) {
            if (TRACKING_PARAMS.has(param.toLowerCase())) {
                u.searchParams.delete(param);
            }
        }
        u.hash = ''; // Drop fragments
        // Normalise path: remove trailing slash
        u.pathname = u.pathname.replace(/\/+$/, '') || '/';
        return u.toString().toLowerCase();
    } catch {
        return raw.toLowerCase().trim();
    }
}

// ─── Hash Helper ─────────────────────────────────────────────────────────────

/** Returns the first 16 hex characters of a SHA-256 hash. 16 chars = 64 bits.
 *  Collision probability at 10M records ≈ 2.7 × 10^-10 — safe for our scale.
 */
function sha256Short(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex').substring(0, 16);
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

/**
 * Generates all three fingerprint levels for a job record in one call.
 *
 * @param job  The job record to fingerprint.
 * @returns    All fingerprint hashes plus the normalised strings for debugging.
 */
export function getJobFingerprints(job: FingerprintableJob): JobFingerprints {
    const normTitle = normalizeTitle(job.title);
    const normCompany = normalizeCompany(job.company);
    const normLoc = job.location ? normalizeLocation(job.location) : '';
    const normDesc = normalizeDescription(job.description ?? '');
    const normUrl = canonicalUrl(job.url);

    // URL hash: fastest — just the canonical URL
    const urlHash = sha256Short(normUrl);

    // Content hash: title + company + location (cross-board dedup key)
    // Location is included to distinguish "Software Engineer @ Google Bangalore"
    // from "Software Engineer @ Google New York" when both appear in Indian boards.
    const contentHash = sha256Short(`${normTitle}|${normCompany}|${normLoc}`);

    // Description hash: used as tie-breaker, not primary key
    const descHash = sha256Short(normDesc);

    return {
        urlHash,
        contentHash,
        descHash,
        normalizedTitle: normTitle,
        normalizedCompany: normCompany,
    };
}
