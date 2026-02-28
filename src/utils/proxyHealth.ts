import { log } from 'crawlee';
import { gotScraping } from 'got-scraping';

/**
 * Validates a list of proxy endpoints and returns only the healthy ones.
 * Automatically strips out malfunctioning or banned proxies.
 * @param proxyUrls Array of proxy strings (e.g., 'http://user:pass@host:port')
 * @returns Array of healthy proxy strings
 */
export async function getHealthyProxies(proxyUrls: string[]): Promise<string[]> {
    log.info(`Validating ${proxyUrls.length} proxies...`);
    const healthyProxies: string[] = [];
    const testTarget = 'https://httpbin.org/ip'; // Tests proxy IP exposure

    // We use Promise.all to test them concurrently without waiting linearly
    const checks = proxyUrls.map(async (proxyUrl) => {
        try {
            // Using got-scraping natively supports proxyUrls and rotates headers
            const response = await gotScraping({
                url: testTarget,
                proxyUrl,
                timeout: { request: 5000 },
                retry: { limit: 0 }, // Fail fast on dead proxies
                responseType: 'json'
            });

            if (response.statusCode === 200) {
                const proxyIp = (response.body as any).origin;
                log.info(`Proxy Health OK. IP resolved as: ${proxyIp}`);
                healthyProxies.push(proxyUrl);
            } else {
                log.warning(`Proxy Failed with status ${response.statusCode}: ${proxyUrl}`);
            }
        } catch (error: any) {
            log.warning(`Proxy Dead (${error.name || error.message}): ${proxyUrl}`);
        }
    });

    await Promise.allSettled(checks);

    log.info(`Proxy validation complete. ${healthyProxies.length}/${proxyUrls.length} recovered.`);
    return healthyProxies;
}
