import { detectPaidProxy } from '../dist/utils/proxyUtils.js';

function setProxyUrls(value) {
    const previous = process.env.PROXY_URLS;
    if (value === undefined || value === null) {
        delete process.env.PROXY_URLS;
    } else {
        process.env.PROXY_URLS = value;
    }
    return () => {
        if (previous === undefined) {
            delete process.env.PROXY_URLS;
        } else {
            process.env.PROXY_URLS = previous;
        }
    };
}

const tests = [
    {
        name: 'returns false when PROXY_URLS is empty',
        run: async () => {
            const restore = setProxyUrls('');
            try {
                if (detectPaidProxy()) {
                    throw new Error('expected empty proxy list to be treated as free');
                }
            } finally {
                restore();
            }
        },
    },
    {
        name: 'returns false when PROXY_URLS has plain HTTP proxies',
        run: async () => {
            const restore = setProxyUrls('http://1.2.3.4:8080,http://5.6.7.8:3128');
            try {
                if (detectPaidProxy()) {
                    throw new Error('expected plain proxies to be treated as free');
                }
            } finally {
                restore();
            }
        },
    },
    {
        name: "returns true when PROXY_URLS contains 'webshare.io'",
        run: async () => {
            const restore = setProxyUrls('http://webshare.io:8080');
            try {
                if (!detectPaidProxy()) {
                    throw new Error('expected webshare to be detected as paid');
                }
            } finally {
                restore();
            }
        },
    },
    {
        name: "returns true when PROXY_URLS contains 'brightdata'",
        run: async () => {
            const restore = setProxyUrls('https://brightdata.com:100');
            try {
                if (!detectPaidProxy()) {
                    throw new Error('expected brightdata to be detected');
                }
            } finally {
                restore();
            }
        },
    },
    {
        name: "returns true when PROXY_URLS contains 'residential' substring",
        run: async () => {
            const restore = setProxyUrls('http://residential.proxy.example:9000');
            try {
                if (!detectPaidProxy()) {
                    throw new Error('expected residential keyword to detect paid proxy');
                }
            } finally {
                restore();
            }
        },
    },
    {
        name: 'is case-insensitive (BRIGHTDATA in uppercase)',
        run: async () => {
            const restore = setProxyUrls('http://BRIGHTDATA.COM:80');
            try {
                if (!detectPaidProxy()) {
                    throw new Error('expected uppercase indicator to match');
                }
            } finally {
                restore();
            }
        },
    },
];

export default tests;
