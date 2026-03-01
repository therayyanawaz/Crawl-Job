/**
 * src/config/foundit.ts — CSS selectors for Foundit.in (ex-Monster India)
 */

export const FounditSelectors = {
    hub: {
        jobListContainer: 'div.srpResultCardContainer, div[class*="card-apply"], div[class*="jobList"]',
        jobCard: 'div.srpResultCardContainer, div[class*="card-apply"], div[class*="jobTuple"]',
        jobLink: 'a[href*="/job/"], a[href*="/job-listings/"], h3.jobTitle a, a[class*="cardTitle"]',
    },
    detail: {
        title: 'h3.jobTitle, h1[class*="title"], h1.jdTitle, h1',
        company: 'span.companyName, a[class*="company"], div[class*="companyName"]',
        location: 'span.loc, span[class*="location"], div[class*="location"]',
        description: 'div[class*="job-desc"], div.jd-desc, section[class*="description"]',
        experience: 'span[class*="exp"], div[class*="experience"]',
        salary: 'span[class*="salary"], span.sal',
        jobType: 'span[class*="type"], span[class*="empType"]',
    },
};

export function buildFounditSearchUrl(keywords: string, location: string, start: number = 0): string {
    const params = new URLSearchParams({
        query: keywords,
        location: location || 'India',
    });
    if (start > 0) params.set('start', String(start));
    return `https://www.foundit.in/srp/results?${params.toString()}`;
}
