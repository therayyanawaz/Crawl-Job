import {
    ensureRequestInterception,
    __resetRequestInterceptionForTests,
} from '../dist/utils/requestInterception.js';

function createMockRoute(requestUrl = 'https://example.com/page', resourceType = 'document') {
    return {
        request: () => ({
            url: () => requestUrl,
            resourceType: () => resourceType,
        }),
        abort: () => 'aborted',
        continue: () => 'continued',
    };
}

const testCases = [
    {
        name: 'ensureRequestInterception registers route only once per page',
        run: async () => {
            __resetRequestInterceptionForTests();

            let routeCallCount = 0;
            let handler;
            const page = {
                route: async (_pattern, nextHandler) => {
                    routeCallCount++;
                    handler = nextHandler;
                },
            };

            for (let i = 0; i < 50; i++) {
                await ensureRequestInterception(page, false);
            }

            if (routeCallCount !== 1) {
                throw new Error(`expected exactly one route registration, got ${routeCallCount}`);
            }

            if (typeof handler !== 'function') {
                throw new Error('expected route handler to be registered');
            }

            const outcome = handler(createMockRoute('https://example.com/jobs', 'document'));
            if (outcome !== 'continued') {
                throw new Error(`expected document request to continue, got ${outcome}`);
            }
        },
    },
    {
        name: 'ensureRequestInterception retries registration after route() failure',
        run: async () => {
            __resetRequestInterceptionForTests();

            let routeCallCount = 0;
            const page = {
                route: async () => {
                    routeCallCount++;
                    if (routeCallCount === 1) {
                        throw new Error('transient route failure');
                    }
                },
            };

            let firstErrorCaught = false;
            try {
                await ensureRequestInterception(page, true);
            } catch {
                firstErrorCaught = true;
            }

            await ensureRequestInterception(page, true);

            if (!firstErrorCaught) {
                throw new Error('expected first route registration to throw');
            }

            if (routeCallCount !== 2) {
                throw new Error(`expected second registration attempt after failure, got ${routeCallCount}`);
            }
        },
    },
];

export default testCases;
