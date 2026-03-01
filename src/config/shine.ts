/**
 * src/config/shine.ts — CSS selectors for Shine.com
 */

export const ShineSelectors = {
    hub: {
        jobListContainer: 'div[class*="jobList"], div[class*="srp_container"], main',
        jobCard: 'article.job-card, div[class*="jsx-job"], div[class*="jobTuple"], li[class*="job"]',
        jobLink: 'a[href*="/job/"], a[href*="/jobs/"], h2 a, h3 a[class*="title"]',
    },
    detail: {
        title: 'h1[class*="title"], h2[class*="title"], h1, h2.job-title',
        company: 'a[class*="company"], span[class*="company"], div[class*="compName"]',
        location: 'span[class*="loc"], span[class*="location"], div[class*="location"]',
        description: 'div[class*="description"], div[class*="jd_content"], section[class*="desc"]',
        experience: 'span[class*="exp"], div[class*="experience"]',
        salary: 'span[class*="salary"], span[class*="sal"]',
        jobType: 'span[class*="type"], span[class*="empType"]',
    },
};

export function buildShineSearchUrl(keywords: string, experience: number = 0, page: number = 1): string {
    const slug = keywords.toLowerCase().replace(/\s+/g, '-');
    let url = `https://www.shine.com/job-search/${slug}-jobs/?q=${encodeURIComponent(keywords)}&experience=${experience}`;
    if (page > 1) url = `https://www.shine.com/job-search/${slug}-jobs/page-${page}/?q=${encodeURIComponent(keywords)}&experience=${experience}`;
    return url;
}
