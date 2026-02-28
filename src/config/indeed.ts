/**
 * src/config/indeed.ts
 *
 * CSS selector map for Indeed.com (global) and in.indeed.com (India).
 *
 * ABOUT INDEED'S HTML STRUCTURE
 * ──────────────────────────────
 * Indeed renders job cards as <li> elements inside a <ul> with a data-testid
 * attribute. The job title inside each card is an <a> with data-testid="job-title".
 * This has been the stable structure since ~2022 Q3, though Indeed periodically
 * A/B tests a completely different layout. Each selector below includes at least
 * one fallback for the alternate layout so extraction keeps working during tests.
 *
 * LAYOUT VERSIONS
 * ───────────────
 * Version A (current primary): data-testid-based selectors
 * Version B (A/B test):        class-name-based selectors (mosaic-*)
 *
 * We always try the primary selector first via CSS comma-or logic;
 * Playwright takes the first element that matches any comma-separated class.
 * If neither matches, we log a warning and the extractor returns empty strings
 * — which then fails Zod validation and is gracefully skipped.
 */

export const IndeedSelectors = {

    // ── Hub Page (Search Results List) ──────────────────────────────────────

    hub: {
        /**
         * <ul> container holding all job cards.
         * Wait for this before trying to extract any cards.
         */
        jobListContainer: 'ul.jobsearch-ResultsList, ul[class*="jobList"]',

        /**
         * Each individual job card (the <li> wrapper).
         * Used to count how many cards loaded for logging.
         */
        jobCard: 'li.css-5lfssm, li[class*="job_seen_beacon"], div[data-testid="slider_item"]',

        /**
         * The clickable <a> tag for each job title.
         * We feed this into enqueueLinks() to collect detail-page URLs.
         * data-testid="job-title" has been stable since late 2022.
         */
        jobLink: 'a[data-testid="job-title"], h2.jobTitle > a, .jobtitle > a',

        /**
         * "Next" pagination button.
         * aria-label='Next Page' is more stable than a CSS class.
         * Indeed uses URL parameter `?start=10` to paginate (10 per page).
         */
        nextButton: 'a[aria-label="Next Page"], a[data-testid="pagination-page-next"]',
    },

    // ── Detail Page (Individual Job Posting) ────────────────────────────────

    detail: {
        /**
         * Main job title H1 on the detail view.
         * data-testid="jobsearch-JobInfoHeader-title" is the primary target.
         * "jobsearch-JobInfoHeader-title-container" is a fallback for older layout.
         */
        title: [
            '[data-testid="jobsearch-JobInfoHeader-title"]',
            '.jobsearch-JobInfoHeader-title',
            'h1[class*="jobTitle"]',
            'h1.jobsearch-JobInfoHeader-title',
        ].join(', '),

        /**
         * Employer name — directly below the H1 in the info header.
         */
        company: [
            '[data-testid="inlineHeader-companyName"] a',
            '[data-testid="inlineHeader-companyName"]',
            '.jobsearch-InlineCompanyRating-companyHeader a',
            '.jobsearch-CompanyInfoContainer a[data-tn-element="companyName"]',
        ].join(', '),

        /**
         * Location string (city, state or "Remote").
         */
        location: [
            '[data-testid="job-location"]',
            '[data-testid="inlineHeader-companyLocation"]',
            '.jobsearch-JobInfoHeader-subtitle div[class*="location"]',
            '.companyLocation',
        ].join(', '),

        /**
         * The full job description body.
         * Indeed wraps this in a specific div; its class has been stable since 2021.
         */
        description: [
            '#jobDescriptionText',
            '[id="jobDescriptionText"]',
            '.jobsearch-jobDescriptionText',
        ].join(', '),

        /**
         * "Posted X days ago" text or <time datetime="..."> element.
         * Prefer the datetime attribute for machine-parseable dates.
         */
        postedDate: [
            '[data-testid="job-age"]',
            '.jobsearch-JobMetadataHeader-item--date',
            'span[class*="date"]',
        ].join(', '),

        /**
         * Salary range — optional, not always present.
         */
        salary: [
            '[data-testid="attribute_snippet_testid"]',
            '.jobsearch-JobMetadataHeader-item--salary',
            '#salaryInfoAndJobType span',
        ].join(', '),

        /**
         * Job type (Full-time, Part-time, Internship, etc.)
         */
        jobType: [
            '[data-testid="attribute_snippet_testid"]',
            '.jobsearch-JobMetadataHeader-item--jobtype',
        ].join(', '),
    },
};

/**
 * Builds an Indeed search URL for job listings.
 *
 * @param query    e.g. "software developer fresher"
 * @param location e.g. "Bangalore" or "India" — leave blank for remote/all
 * @param start    Pagination offset (0, 10, 20 …)
 * @param domain   Either "in.indeed.com" (India) or "www.indeed.com" (global)
 */
export function buildIndeedSearchUrl(
    query: string,
    location: string,
    start: number,
    domain: 'in.indeed.com' | 'www.indeed.com' = 'in.indeed.com'
): string {
    const params = new URLSearchParams({
        q: query,
        ...(location ? { l: location } : {}),
        ...(start > 0 ? { start: String(start) } : {}),
        sort: 'date',   // Most recent first — better for active job hunting
        limit: '10',
    });
    return `https://${domain}/jobs?${params.toString()}`;
}

/**
 * Extracts the `start` offset from an Indeed pagination URL.
 * Returns 0 if not found (first page).
 */
export function getIndeedStartOffset(url: string): number {
    try {
        return Number(new URL(url).searchParams.get('start') ?? '0');
    } catch {
        return 0;
    }
}
