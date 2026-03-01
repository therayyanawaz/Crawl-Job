/**
 * src/config/wellfound.ts — CSS selectors for Wellfound
 */

export const WellfoundSelectors = {
    hub: {
        jobListContainer: 'div[class*="startupResults"], div[class*="JobList"]',
        jobCard: 'div[class*="styles_component__"], div[class*="styles_jobList__"] > div',
        jobLink: 'a[href*="/jobs/"], a[class*="styles_jobTitle__"]',
        nextButton: 'button[class*="styles_next__"]',
    },
    detail: {
        title: 'h2[class*="styles_component__"], h1.startup-header',
        company: 'h1[class*="styles_name__"], div[class*="companyName"]',
        location: 'div[class*="styles_location__"]',
        description: 'div[class*="styles_description__"], div.job-description',
    },
};

export function buildWellfoundSearchUrl(keywords: string, location: string = ''): string {
    const params = new URLSearchParams({});
    // Wellfound often ignores query params without a user account context for specific searches.
    // However, they have /role/ patterns. The user gave 'wellfound.com/jobs'.
    // We will use standard jobs page and try to pass basic params.
    if (keywords) params.set('search', keywords);
    if (location) params.set('location', location);

    return `https://wellfound.com/jobs?${params.toString()}`;
}
