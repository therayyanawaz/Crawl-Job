import {
    recordRequest,
    releaseRequest,
    getDomainStats,
    resetCounters,
} from '../dist/utils/domainQueue.js';

const testCases = [
    {
        name: 'release in finally returns activeConcurrent to baseline after throw',
        run: async () => {
            const domain = 'example.com';
            await resetCounters();

            const before = await getDomainStats(domain);
            if (before.activeConcurrent !== 0) {
                throw new Error(`expected clean baseline activeConcurrent=0, got ${before.activeConcurrent}`);
            }

            let caught = false;
            try {
                await recordRequest(domain);
                throw new Error('simulated request failure after acquire');
            } catch {
                caught = true;
            } finally {
                await releaseRequest(domain);
            }

            if (!caught) {
                throw new Error('expected simulated failure to be caught');
            }

            const after = await getDomainStats(domain);
            if (after.activeConcurrent !== 0) {
                throw new Error(`expected activeConcurrent to return to 0, got ${after.activeConcurrent}`);
            }
        },
    },
    {
        name: 'releaseRequest is idempotent and never drives activeConcurrent below zero',
        run: async () => {
            const domain = 'idempotent.example.com';
            await resetCounters();

            await recordRequest(domain);
            await releaseRequest(domain);
            await releaseRequest(domain);

            const stats = await getDomainStats(domain);
            if (stats.activeConcurrent !== 0) {
                throw new Error(`expected idempotent release to clamp at 0, got ${stats.activeConcurrent}`);
            }
        },
    },
];

export default testCases;
