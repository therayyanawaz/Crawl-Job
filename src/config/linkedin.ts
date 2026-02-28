/**
 * src/config/linkedin.ts
 *
 * CSS selector map for LinkedIn public job search (no login required).
 *
 * ABOUT LINKEDIN'S HTML STRUCTURE
 * ─────────────────────────────────
 * LinkedIn's public job listings at /jobs/search/ are server-side rendered
 * for the initial page load and then hydrated via React. Crucially, the INITIAL
 * HTML contains all job cards — we do NOT need JavaScript execution to see them.
 * This means waitForSelector() on the first card is usually enough.
 *
 * KNOWN CHALLENGE: LinkedIn injects a login wall ("Join now to view all results")
 * after the first ~25 results on public search. We handle this by:
 *   a) Extracting only the visible cards (no login required for those).
 *   b) Never clicking the job links (which redirect to login).
 *   c) Instead, we construct direct job-detail URLs from the job IDs embedded
 *      in the card's data-entity-urn attribute.
 *
 * Detail pages (/jobs/view/<id>/) are publicly accessible when accessed directly
 * (not via the SPA link click). This is the key architectural trick.
 *
 * PAGINATION
 * ───────────
 * LinkedIn public search paginates via ?start=N (25 per page).
 *   Page 1: ?start=0  (or no start param)
 *   Page 2: ?start=25
 *   Page 3: ?start=50
 *   ...up to ~100 results (4 pages) before login wall blocks further results.
 *
 * For student job hunting, 100 results per search query is more than sufficient.
 */

export const LinkedInSelectors = {

    // ── Hub Page (Public Search Results) ────────────────────────────────────

    hub: {
        /**
         * Container holding all visible job cards.
         * LinkedIn uses nested ul/li or a flat div structure depending on
         * which A/B test variant you land in.
         */
        jobListContainer: [
            'ul.jobs-search__results-list',
            'ul.jobs-search-results__list',
            'div.jobs-search-results-grid',
        ].join(', '),

        /**
         * Each individual job card element.
         * Used to count visible cards and extract job IDs.
         */
        jobCard: [
            'li.jobs-search-results__list-item',
            'li[class*="job-card-container"]',
            'div[data-occludable-job-id]',
        ].join(', '),

        /**
         * The data attribute holding the numeric LinkedIn job ID.
         * We read this attribute from each card to build the direct detail URL.
         * This avoids following the SPA link that triggers the login wall.
         *
         * Usage: element.getAttribute('data-entity-urn') ?
         *   → "urn:li:fs_normalized_jobPosting:3812345678"
         *   → extract trailing numeric ID
         */
        jobIdAttr: 'data-entity-urn',

        /**
         * Fallback: the <a> href on the job card title.
         * Pattern: /jobs/view/<numeric-id>/
         * We extract the ID from the href when data-entity-urn is absent.
         */
        jobCardLink: [
            'a[href*="/jobs/view/"]',
            '.base-card__full-link',
            '.job-card-list__title',
        ].join(', '),

        /**
         * Job title text within the card (for quick logging).
         */
        cardTitle: [
            'h3.base-search-card__title',
            '.job-card-list__title',
            'h3[class*="job-card"]',
        ].join(', '),

        /**
         * Company name within the card (for quick logging).
         */
        cardCompany: [
            'h4.base-search-card__subtitle',
            '.job-card-container__company-name',
        ].join(', '),

        /**
         * "No more jobs" / login wall indicator.
         * When this element appears the page has no more public results.
         */
        loginWall: [
            '.jobs-guest-see-all__bottom-sheet',
            '.join-now-callout',
            'button[data-tracking-control-name="public_jobs_sign-up-modal_trigger"]',
        ].join(', '),
    },

    // ── Detail Page (/jobs/view/<id>/) ───────────────────────────────────────

    detail: {
        /**
         * Main job title — large H1 at the top of the detail page.
         */
        title: [
            'h1.top-card-layout__title',
            'h1[class*="job-details-jobs-unified-top-card__job-title"]',
            'h1.topcard__title',
        ].join(', '),

        /**
         * Company name — linked text under the title.
         */
        company: [
            'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
            '.top-card-layout__first-subline a',
            '.topcard__org-name-link',
            'a[class*="company-name"]',
        ].join(', '),

        /**
         * Location — city/region text, sometimes "Remote".
         */
        location: [
            '.top-card-layout__second-subline .topcard__flavor:first-child',
            '[class*="job-details-jobs-unified-top-card__bullet"]',
            '.topcard__flavor--bullet',
        ].join(', '),

        /**
         * Full job description — the longest text block on the page.
         */
        description: [
            'section.show-more-less-html .show-more-less-html__markup',
            '.description__text',
            'div[class*="description"] .show-more-less-html__markup',
        ].join(', '),

        /**
         * "Posted X time ago" — relative date string.
         */
        postedDate: [
            'span[class*="posted-time-ago"]',
            '.topcard__flavor--metadata',
            'time',
        ].join(', '),

        /**
         * Employment type (Full-time, Internship, Contract…).
         */
        jobType: [
            'span[class*="employment-type"]',
            '.description__job-criteria-text--criteria',
        ].join(', '),

        /**
         * Seniority level (Entry level, Associate, Mid-Senior…).
         */
        seniority: [
            'span[class*="experience-level"]',
            'li[class*="job-criteria__item"]:nth-child(1) span',
        ].join(', '),
    },
};

/**
 * Builds a LinkedIn public job search URL.
 *
 * @param keywords  e.g. "software developer internship"
 * @param location  e.g. "India" — LinkedIn uses GeoID internally but plain text works too
 * @param start     Pagination offset: 0, 25, 50, 75 (max 100 public results)
 * @param sortBy    "DD" = date descending (most recent first) — best for job hunting
 */
export function buildLinkedInSearchUrl(
    keywords: string,
    location: string,
    start: number,
    sortBy: 'DD' | 'R' = 'DD'
): string {
    const params = new URLSearchParams({
        keywords,
        location,
        trk: 'public_jobs_jobs-search-bar_search-submit',
        position: '1',
        pageNum: '0',
        ...(start > 0 ? { start: String(start) } : {}),
        sortBy,
    });
    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * Extracts the numeric LinkedIn job ID from a variety of strings:
 *   - "urn:li:fs_normalized_jobPosting:3812345678" → "3812345678"
 *   - "/jobs/view/3812345678/"                     → "3812345678"
 *   - "3812345678"                                 → "3812345678"
 *
 * Returns null if no ID can be parsed.
 */
export function extractLinkedInJobId(input: string): string | null {
    // URN format (data-entity-urn attribute)
    const urnMatch = input.match(/:(\d{10,})$/);
    if (urnMatch) return urnMatch[1];

    // URL format
    const urlMatch = input.match(/\/jobs\/view\/(\d+)/);
    if (urlMatch) return urlMatch[1];

    // Plain number string
    if (/^\d{8,}$/.test(input.trim())) return input.trim();

    return null;
}

/**
 * Builds the canonical public detail URL from a LinkedIn job ID.
 */
export function buildLinkedInDetailUrl(jobId: string): string {
    return `https://www.linkedin.com/jobs/view/${jobId}/`;
}
