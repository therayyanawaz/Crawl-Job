/**
 * src/config/rateLimits.ts
 *
 * Domain-specific rate-limit configuration for the student job-scraper.
 *
 * Design philosophy
 * ─────────────────
 * Every limit here is deliberately conservative. Getting banned on LinkedIn
 * or Naukri means losing access to the platform you need most for your
 * actual job hunt — not just for scraping. When in doubt, slow down.
 *
 * The values below are derived from:
 *  • Community reports on scraping forums (2023-2025 data)
 *  • CloudFlare / Akamai detection thresholds for career portals
 *  • Observed session lifetimes on each platform
 *  • IST business-hours vs. off-hours traffic patterns
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
    /** Canonical domain key, e.g. "linkedin.com" */
    domain: string;

    /** Maximum requests per minute across ALL concurrency slots. */
    maxRequestsPerMinute: number;

    /** Minimum milliseconds to wait between consecutive requests to this domain. */
    minDelayMs: number;

    /**
     * Random jitter added on top of minDelayMs.
     * Actual delay = minDelayMs + random(0, jitterMs)
     * Jitter prevents the perfectly-timed requests that bot detectors flag.
     */
    jitterMs: number;

    /**
     * Maximum browser contexts (tabs) open simultaneously against this domain.
     * Keep this ≤ 2 for high-risk domains regardless of overall maxConcurrency.
     */
    maxConcurrentPerDomain: number;

    /**
     * Risk tier. Determines backoff multiplier and how aggressively we
     * retire sessions after a 429.
     *
     * HIGH   → personal account / legal risk (LinkedIn, Glassdoor)
     * MEDIUM → moderate bot-detection (Indeed, Naukri)
     * LOW    → lenient or student-friendly (Internshala, Cutshort)
     */
    riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';

    /**
     * Multiplier applied to minDelayMs during IST business hours (9:00–19:00).
     * Higher traffic = more human noise to hide in during off-hours instead.
     * Counterintuitively, for HIGH-risk domains we scrape during off-hours
     * (late night IST) to avoid triggering rate-limit thresholds.
     */
    businessHoursMultiplier: number;

    /**
     * Base multiplier for exponential backoff when a 429/block is detected.
     * Actual backoff = baseBackoffMs * (backoffMultiplier ^ attempt)
     */
    backoffMultiplier: number;

    /** Maximum milliseconds to wait during any single backoff period. */
    maxBackoffMs: number;

    /**
     * Whether authentication is required to get useful data from this domain.
     * true  → you MUST log in (data is behind auth wall)
     * false → public pages have enough data — NEVER log in with personal account
     *
     * IMPORTANT: For domains marked requiresAuth=true, create a THROWAWAY
     * account. Never use your real LinkedIn/Naukri profile for automated scraping.
     */
    requiresAuth: boolean;

    /** Human-readable notes for your reference. */
    notes: string;
}

// ─── Per-Domain Configurations ────────────────────────────────────────────────

const DOMAIN_CONFIGS: Record<string, RateLimitConfig> = {

    // ── LinkedIn ────────────────────────────────────────────────────────────
    // LinkedIn employs Datadome, bot-score fingerprinting, and account-level
    // behavioural analysis. Getting your ACCOUNT flagged here can result in a
    // permanent restriction — far worse than a temporary IP block. Treat
    // LinkedIn as untouchable with your personal account.
    // Recommendation: scrape the public /jobs/ search pages only (no login).
    'linkedin.com': {
        domain: 'linkedin.com',
        maxRequestsPerMinute: 4,
        minDelayMs: 8_000,
        jitterMs: 5_000,
        maxConcurrentPerDomain: 1,
        riskLevel: 'HIGH',
        businessHoursMultiplier: 2.5,
        backoffMultiplier: 3,
        maxBackoffMs: 10 * 60 * 1000,   // 10 minutes max backoff
        requiresAuth: false,
        notes: 'Public job search only. Never scrape with personal account. Datadome protected.'
    },

    'in.linkedin.com': {
        domain: 'in.linkedin.com',
        maxRequestsPerMinute: 4,
        minDelayMs: 8_000,
        jitterMs: 5_000,
        maxConcurrentPerDomain: 1,
        riskLevel: 'HIGH',
        businessHoursMultiplier: 2.5,
        backoffMultiplier: 3,
        maxBackoffMs: 10 * 60 * 1000,
        requiresAuth: false,
        notes: 'India subdomain — same rules as linkedin.com.'
    },

    // ── Indeed ──────────────────────────────────────────────────────────────
    // Indeed uses Akamai Bot Manager. Public search pages are accessible
    // without login. The Indian subdomain (in.indeed.com) has lighter
    // bot-detection than the US version.
    'indeed.com': {
        domain: 'indeed.com',
        maxRequestsPerMinute: 8,
        minDelayMs: 5_000,
        jitterMs: 3_000,
        maxConcurrentPerDomain: 2,
        riskLevel: 'MEDIUM',
        businessHoursMultiplier: 1.8,
        backoffMultiplier: 2,
        maxBackoffMs: 5 * 60 * 1000,    // 5 minutes max backoff
        requiresAuth: false,
        notes: 'Akamai protected. Avoid scraping job-detail pages faster than human reading speed.'
    },

    'in.indeed.com': {
        domain: 'in.indeed.com',
        maxRequestsPerMinute: 10,
        minDelayMs: 4_000,
        jitterMs: 3_000,
        maxConcurrentPerDomain: 2,
        riskLevel: 'MEDIUM',
        businessHoursMultiplier: 1.5,
        backoffMultiplier: 2,
        maxBackoffMs: 5 * 60 * 1000,
        requiresAuth: false,
        notes: 'Slightly more lenient than US indeed.com. Good for freshers/entry-level searches.'
    },

    // ── Naukri ──────────────────────────────────────────────────────────────
    // Naukri (naukri.com) is the dominant Indian job board. It uses custom
    // in-house bot detection. Public search pages load as SSR HTML —
    // CheerioCrawler would actually work here, but we stay on Playwright
    // for consistency. Session-based blocking is common after ~50 requests/session.
    'naukri.com': {
        domain: 'naukri.com',
        maxRequestsPerMinute: 10,
        minDelayMs: 4_000,
        jitterMs: 3_500,
        maxConcurrentPerDomain: 2,
        riskLevel: 'MEDIUM',
        businessHoursMultiplier: 1.6,
        backoffMultiplier: 2,
        maxBackoffMs: 8 * 60 * 1000,
        requiresAuth: false,
        notes: 'Session lifetime ~50 requests. Rotate sessions proactively. Good fresher listings.'
    },

    // ── Internshala ─────────────────────────────────────────────────────────
    // Internshala is the most student-friendly platform technically.
    // It has minimal bot detection and publicly lists all internships.
    // This should be your PRIMARY scraping target for Week 1.
    'internshala.com': {
        domain: 'internshala.com',
        maxRequestsPerMinute: 15,
        minDelayMs: 3_000,
        jitterMs: 2_000,
        maxConcurrentPerDomain: 3,
        riskLevel: 'LOW',
        businessHoursMultiplier: 1.2,
        backoffMultiplier: 1.5,
        maxBackoffMs: 3 * 60 * 1000,
        requiresAuth: false,
        notes: 'Most lenient of all platforms. Start here. All internships are publicly listed.'
    },

    // ── Wellfound (formerly AngelList) ──────────────────────────────────────
    // Wellfound serves startup jobs globally. Has React SPA — requires
    // Playwright (JS execution). Moderate bot-detection via Cloudflare Turnstile
    // on some pages. Startup internships are gold for students — worth the care.
    'wellfound.com': {
        domain: 'wellfound.com',
        maxRequestsPerMinute: 8,
        minDelayMs: 6_000,
        jitterMs: 4_000,
        maxConcurrentPerDomain: 1,
        riskLevel: 'MEDIUM',
        businessHoursMultiplier: 1.5,
        backoffMultiplier: 2,
        maxBackoffMs: 6 * 60 * 1000,
        requiresAuth: false,
        notes: 'React SPA. Some pages behind soft auth wall. Startup roles often unadvertised elsewhere.'
    },

    // ── Glassdoor ───────────────────────────────────────────────────────────
    // Glassdoor aggressively prompts for login/signup after a few page views.
    // Use it primarily for company research, not bulk job scraping.
    // Bot-detection: Cloudflare + custom challenge scripts.
    'glassdoor.com': {
        domain: 'glassdoor.com',
        maxRequestsPerMinute: 5,
        minDelayMs: 8_000,
        jitterMs: 5_000,
        maxConcurrentPerDomain: 1,
        riskLevel: 'HIGH',
        businessHoursMultiplier: 2.0,
        backoffMultiplier: 3,
        maxBackoffMs: 10 * 60 * 1000,
        requiresAuth: false,
        notes: 'Use for company research only. Paywalls kick in after ~5 reviews. High Cloudflare score.'
    },

    // ── HackerEarth Jobs ────────────────────────────────────────────────────
    // HackerEarth's job section is lightly protected. Good for tech-specific
    // roles and hackathon-linked internships.
    'hackerearth.com': {
        domain: 'hackerearth.com',
        maxRequestsPerMinute: 15,
        minDelayMs: 3_000,
        jitterMs: 2_000,
        maxConcurrentPerDomain: 3,
        riskLevel: 'LOW',
        businessHoursMultiplier: 1.2,
        backoffMultiplier: 1.5,
        maxBackoffMs: 3 * 60 * 1000,
        requiresAuth: false,
        notes: 'Tech-focused roles. Good for SDE and cybersecurity internships. Low detection risk.'
    },

    // ── Cutshort ────────────────────────────────────────────────────────────
    // Cutshort is an AI-powered job board for tech roles. Light infrastructure,
    // minimal bot-detection. Good source for startup SDE roles.
    'cutshort.io': {
        domain: 'cutshort.io',
        maxRequestsPerMinute: 12,
        minDelayMs: 4_000,
        jitterMs: 2_500,
        maxConcurrentPerDomain: 2,
        riskLevel: 'LOW',
        businessHoursMultiplier: 1.3,
        backoffMultiplier: 1.5,
        maxBackoffMs: 3 * 60 * 1000,
        requiresAuth: false,
        notes: 'Startup-focused. Good for remote tech roles. Minimal protection.'
    },

    // ── Instahyre ───────────────────────────────────────────────────────────
    // AI-matched job board. Most listings visible without login.
    // Rate-limiting triggers if you cycle through search filters rapidly.
    'instahyre.com': {
        domain: 'instahyre.com',
        maxRequestsPerMinute: 10,
        minDelayMs: 4_500,
        jitterMs: 3_000,
        maxConcurrentPerDomain: 2,
        riskLevel: 'LOW',
        businessHoursMultiplier: 1.3,
        backoffMultiplier: 1.5,
        maxBackoffMs: 4 * 60 * 1000,
        requiresAuth: false,
        notes: 'AI-matched roles. Good for mid-level but has some fresher listings too.'
    },
};

// ─── Default Fallback ─────────────────────────────────────────────────────────

/** Conservative fallback used for any domain not explicitly listed above. */
const DEFAULT_CONFIG: RateLimitConfig = {
    domain: 'default',
    maxRequestsPerMinute: 10,
    minDelayMs: 5_000,
    jitterMs: 3_000,
    maxConcurrentPerDomain: 2,
    riskLevel: 'MEDIUM',
    businessHoursMultiplier: 1.5,
    backoffMultiplier: 2,
    maxBackoffMs: 5 * 60 * 1000,
    requiresAuth: false,
    notes: 'Default fallback for unlisted domains.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the root domain from a full URL or hostname string.
 * "https://in.linkedin.com/jobs/..." → "in.linkedin.com"
 * Strips "www." prefix automatically.
 */
export function extractDomain(urlOrHost: string): string {
    try {
        const host = urlOrHost.startsWith('http')
            ? new URL(urlOrHost).hostname
            : urlOrHost;
        return host.replace(/^www\./, '');
    } catch {
        return urlOrHost;
    }
}

/**
 * Returns the RateLimitConfig for a given domain.
 * Falls back to DEFAULT_CONFIG for unknown domains.
 */
export function getRateLimitConfig(domain: string): RateLimitConfig {
    const clean = extractDomain(domain);

    // Exact match first
    if (DOMAIN_CONFIGS[clean]) return DOMAIN_CONFIGS[clean];

    // Then check if the domain ends with a known key (e.g. "jobs.linkedin.com")
    for (const key of Object.keys(DOMAIN_CONFIGS)) {
        if (clean.endsWith(key)) return DOMAIN_CONFIGS[key];
    }

    return { ...DEFAULT_CONFIG, domain: clean };
}

/**
 * Returns the calculated delay in milliseconds before the next request to
 * this domain, accounting for:
 *  - Base + random jitter
 *  - IST time-of-day multiplier (business hours are 09:00–19:00 IST)
 *
 * We purposefully scrape HIGH-risk domains during off-hours (late night IST)
 * when human traffic is low and rate-limit counters have partially reset.
 */
export function getDelayForDomain(domain: string, now: Date = new Date()): number {
    const config = getRateLimitConfig(domain);

    // Determine IST hour (UTC+5:30)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istHour = new Date(now.getTime() + istOffsetMs).getUTCHours();

    const isBusinessHours = istHour >= 9 && istHour < 19;
    const timeMultiplier = isBusinessHours ? config.businessHoursMultiplier : 1.0;

    // Read env overrides (allow operator to tweak without code changes)
    const baseDelayOverride = process.env.BASE_DELAY_MS ? Number(process.env.BASE_DELAY_MS) : null;
    const jitterOverride = process.env.RANDOM_DELAY_RANGE_MS ? Number(process.env.RANDOM_DELAY_RANGE_MS) : null;

    const base = baseDelayOverride ?? config.minDelayMs;
    const jitter = jitterOverride ?? config.jitterMs;

    const rawDelay = (base + Math.random() * jitter) * timeMultiplier;
    return Math.round(rawDelay);
}

/**
 * Returns whether the current IST time falls within "off-hours"
 * as defined by the OFF_HOURS_START / OFF_HOURS_END env vars.
 *
 * Default: off-hours = 22:00 IST → 06:00 IST (best time for HIGH-risk domains).
 */
export function isOffHoursIST(now: Date = new Date()): boolean {
    const offStart = Number(process.env.OFF_HOURS_START ?? 22);
    const offEnd = Number(process.env.OFF_HOURS_END ?? 6);

    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const h = new Date(now.getTime() + istOffsetMs).getUTCHours();

    // Wraps midnight: offStart=22, offEnd=6 → 22..23..0..1..2..3..4..5
    if (offStart > offEnd) return h >= offStart || h < offEnd;
    return h >= offStart && h < offEnd;
}

export { DOMAIN_CONFIGS, DEFAULT_CONFIG };
