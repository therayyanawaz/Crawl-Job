type MinimalRoute = {
    request(): {
        url(): string;
        resourceType(): string;
    };
    abort(): unknown;
    continue(): unknown;
};

type MinimalPage = {
    route(
        url: string,
        handler: (route: MinimalRoute) => unknown
    ): Promise<unknown> | unknown;
};

const ALWAYS_BLOCK_PATTERNS = [
    'google-analytics',
    'facebook.net',
    'hotjar',
    'doubleclick',
    'googlesyndication',
    'googletagmanager',
    'linkedin.com/li/track',
    'bat.bing.com',
];

const PAID_PROXY_EXTRA_BLOCK_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

let routedPages = new WeakSet<object>();

export function shouldBlockRequest(
    requestUrl: string,
    resourceType: string,
    hasPaidProxy: boolean
): boolean {
    if (ALWAYS_BLOCK_PATTERNS.some((pattern) => requestUrl.includes(pattern))) {
        return true;
    }

    if (hasPaidProxy && PAID_PROXY_EXTRA_BLOCK_TYPES.has(resourceType)) {
        return true;
    }

    return false;
}

export async function ensureRequestInterception(
    page: MinimalPage,
    hasPaidProxy: boolean
): Promise<boolean> {
    const key = page as unknown as object;

    if (routedPages.has(key)) {
        return false;
    }

    routedPages.add(key);

    try {
        await page.route('**/*', (route: MinimalRoute) => {
            const requestUrl = route.request().url();
            const resourceType = route.request().resourceType();

            if (shouldBlockRequest(requestUrl, resourceType, hasPaidProxy)) {
                return route.abort();
            }

            return route.continue();
        });

        return true;
    } catch (err) {
        routedPages.delete(key);
        throw err;
    }
}

export function __resetRequestInterceptionForTests(): void {
    routedPages = new WeakSet<object>();
}
