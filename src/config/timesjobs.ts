/**
 * src/config/timesjobs.ts — CSS selectors for TimesJobs
 */

export const TimesJobsSelectors = {
    hub: {
        jobListContainer: 'ul.new-joblist',
        jobCard: 'li.clearfix.job-bx.wht-shd-bx',
        jobLink: 'h2 a',
    },
    detail: {
        title: 'h1.jd-job-title',
        company: 'h2.jd-comp-name, h2.heading',
        location: 'span.loc, div.location',
        description: 'div.jd-desc, section[class*="description"]',
        experience: 'li[title="experience"] i, span.exp',
        salary: 'li[title="salary"] i, span.sal',
    },
};

export function buildTimesJobsSearchUrl(keywords: string, location: string = '', page: number = 1): string {
    const params = new URLSearchParams({
        searchType: 'personalizedSearch',
        from: 'submit',
        txtKeywords: keywords,
        txtLocation: location,
        sequence: String(page),
        startPage: '1'
    });
    return `https://www.timesjobs.com/candidate/job-search.html?${params.toString()}`;
}
