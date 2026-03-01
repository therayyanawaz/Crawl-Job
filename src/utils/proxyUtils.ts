/**
 * Detects if PROXY_URLS contain paid/residential indicator keywords.
 * This is a pure helper so tests can call it without booting the crawler.
 */
export function detectPaidProxy(): boolean {
    const raw = process.env.PROXY_URLS ?? '';
    if (!raw) return false;

    const paidIndicators = [
        'webshare.io',
        'oxylabs.',
        'brightdata.',
        'smartproxy.',
        'zyte.com',
        'storm-',
        'residential',
        '-rotate',
        'superproxy.',
        'iproyal.',
        'proxy-seller.',
        'proxy.google',
    ];

    const lower = raw.toLowerCase();
    return paidIndicators.some((ind) => lower.includes(ind));
}
