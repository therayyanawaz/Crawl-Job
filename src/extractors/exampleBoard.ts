import { PlaywrightCrawlingContext } from 'crawlee';
import { Selectors } from '../config.js';

export async function extractExampleBoard({ page, enqueueLinks, request, log }: PlaywrightCrawlingContext) {
    log.info(`Processing hub page: ${request.url}`);

    await page.waitForSelector(Selectors.exampleBoard.jobLink, { timeout: 10000 }).catch(() => null);

    await enqueueLinks({
        selector: Selectors.exampleBoard.jobLink,
        label: 'JOB_DETAIL',
        strategy: 'same-domain'
    });

    const nextButtonHref = await page.getAttribute('.pagination-next', 'href').catch(() => null);

    if (nextButtonHref) {
        log.info(`Found next page: ${nextButtonHref}`);
        await enqueueLinks({
            urls: [new URL(nextButtonHref, request.loadedUrl || request.url).toString()],
            label: 'BOARD_HUB'
        });
    } else {
        log.info(`Reached end of pagination for: ${request.url}`);
    }
}
