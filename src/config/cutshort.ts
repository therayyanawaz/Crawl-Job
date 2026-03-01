/**
 * src/config/cutshort.ts — CSS selectors for Cutshort.io
 */

export const CutshortSelectors = {
    hub: {
        jobListContainer: 'div[class*="job-listing"], div[class*="jobs-list"], main',
        jobCard: 'div[class*="job-card"], article[data-job-id], div[class*="job-item"]',
        jobLink: 'a[href*="/job/"], a[href*="/jobs/"], div[class*="job-card"] a',
    },
    detail: {
        title: 'h1[class*="title"], h2[class*="title"], h1',
        company: 'span[class*="company"], a[class*="company"], div[class*="company"] span',
        location: 'span[class*="location"], div[class*="location"]',
        description: 'div[class*="description"], div[class*="job-desc"], section[class*="description"]',
        applyLink: 'a[class*="apply"], button[class*="apply"]',
        experience: 'span[class*="experience"], div[class*="experience"]',
        jobType: 'span[class*="job-type"], div[class*="employment"]',
    },
};

export function buildCutshortSearchUrl(keywords: string, page: number = 1): string {
    const params = new URLSearchParams({
        keywords: keywords,
        experience: '0-1',
    });
    if (page > 1) params.set('page', String(page));
    return `https://cutshort.io/jobs?${params.toString()}`;
}
