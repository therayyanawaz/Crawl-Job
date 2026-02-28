import { log } from 'crawlee';
import { gotScraping } from 'got-scraping';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawProxy {
    host: string;
    port: number;
    protocol: 'http' | 'https' | 'socks4' | 'socks5' | string;
    source: string;
    username?: string;
    password?: string;
}

// ─── Source Definitions ───────────────────────────────────────────────────────

/**
 * Each source definition tells us how to fetch and parse a free proxy feed.
 *
 * Why separate source objects instead of a flat list?
 * Every public provider returns a completely different payload shape.
 * Isolating the parsing logic per-source means a broken feed only kills
 * that one source, not the whole fetcher.
 */

async function fetchProxyScrapeApi(): Promise<RawProxy[]> {
    // ProxyScrape v3 - using text response as the 'displayproxies' request returns plain text
    const url =
        'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous&limit=100';

    try {
        const response = await gotScraping({
            url,
            responseType: 'text',
            timeout: { request: 10_000 },
            retry: { limit: 1 },
        });

        // Response is plain text: one "ip:port" per line
        const lines: string[] = (response.body as string)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        const proxies: RawProxy[] = lines.map((line) => {
            const [host, portStr] = line.split(':');
            return {
                host,
                port: Number(portStr),
                protocol: 'http' as RawProxy['protocol'],
                source: 'proxyscrape-v3',
            };
        }).filter((p) => p.host && !isNaN(p.port) && p.port > 0);

        log.info(`[ProxyScrape-v3] Fetched ${proxies.length} raw proxies.`);
        return proxies;
    } catch (err: any) {
        log.warning(`[ProxyScrape-v3] Fetch failed: ${err.message}`);
        return [];
    }
}

async function fetchGeonodeApi(): Promise<RawProxy[]> {
    // Geonode - updated URL with more relaxed filters to ensure results
    const url =
        'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http,https';

    try {
        const response = await gotScraping({
            url,
            responseType: 'json',
            timeout: { request: 10_000 },
            retry: { limit: 1 },
        });

        const body = response.body as any;
        const proxies: RawProxy[] = (body?.data ?? []).map((p: any) => ({
            host: p.ip,
            port: Number(p.port),
            protocol: (Array.isArray(p.protocols) && p.protocols.length > 0 ? p.protocols[0] : 'http').toLowerCase() as RawProxy['protocol'],
            source: 'geonode',
        }));

        log.info(`[Geonode] Fetched ${proxies.length} raw proxies.`);
        return proxies;
    } catch (err: any) {
        log.warning(`[Geonode] Fetch failed: ${err.message}`);
        return [];
    }
}

async function fetchFreeProxyListNet(): Promise<RawProxy[]> {
    // free-proxy-list.net exposes a plain-text API endpoint.
    // This is one of the oldest public proxy lists still operational.
    const url = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all';

    try {
        const response = await gotScraping({
            url,
            responseType: 'text',
            timeout: { request: 10_000 },
            retry: { limit: 1 },
        });

        // Response is plain text: one "ip:port" per line
        const lines: string[] = (response.body as string)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        const proxies: RawProxy[] = lines.map((line) => {
            const [host, portStr] = line.split(':');
            return {
                host,
                port: Number(portStr),
                protocol: 'http' as RawProxy['protocol'],
                source: 'freeproxylist-txt',
            };
        }).filter((p) => p.host && !isNaN(p.port) && p.port > 0);

        log.info(`[FreeProxyList-txt] Fetched ${proxies.length} raw proxies.`);
        return proxies;
    } catch (err: any) {
        log.warning(`[FreeProxyList-txt] Fetch failed: ${err.message}`);
        return [];
    }
}

// ─── Public Entry Point ────────────────────────────────────────────────────────

/**
 * Aggregates proxies from every configured free source in parallel.
 * Deduplicates by host:port so the same IP doesn't appear multiple times.
 *
 * @returns Array of raw (unvalidated) proxy objects
 */
export async function fetchAllFreeProxies(): Promise<RawProxy[]> {
    log.info('Fetching free proxy lists from all sources in parallel...');

    const [geonode, fplTxt] = await Promise.allSettled([
        fetchGeonodeApi(),
        fetchFreeProxyListNet(),
    ]);

    const all: RawProxy[] = [
        ...(geonode.status === 'fulfilled' ? geonode.value : []),
        ...(fplTxt.status === 'fulfilled' ? fplTxt.value : []),
    ];

    if (all.length < 20) {
        log.info('Primary free proxy sources yielded too few. Falling back to ProxyScrape...');
        const proxyScrape = await fetchProxyScrapeApi();
        all.push(...proxyScrape);
    }

    // Deduplicate by "host:port" key
    const seen = new Set<string>();
    const unique = all.filter((p) => {
        const key = `${p.host}:${p.port}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    log.info(`Free proxy fetch complete. ${unique.length} unique proxies across all sources.`);
    return unique;
}

/**
 * Converts a RawProxy object into the URL string format Crawlee expects.
 * e.g.  { host: '1.2.3.4', port: 8080, protocol: 'http' }  →  'http://1.2.3.4:8080'
 */
export function toProxyUrl(proxy: RawProxy): string {
    let auth = '';
    if (proxy.username && proxy.password) {
        auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}@`;
    } else if (proxy.username) {
        auth = `${decodeURIComponent(proxy.username)}@`;
    }
    return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}
