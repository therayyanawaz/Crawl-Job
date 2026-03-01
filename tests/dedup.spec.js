import { initDedupStore, closeDedupStore, clearDedupStore } from './harness.mjs';
import { isDuplicateJob, markJobAsStored } from '../dist/utils/dedup.js';

const createJob = (suffix, overrides = {}) => ({
    url: `https://example.com/job-${suffix}`,
    title: 'Software Engineer',
    company: 'Example Corp',
    description: 'Test description',
    ...overrides,
});

async function withFreshStore(fn) {
    clearDedupStore();
    initDedupStore();
    try {
        await fn();
    } finally {
        closeDedupStore();
    }
}

const tests = [
    {
        name: 'returns not duplicate for new job',
        run: async () => {
            await withFreshStore(async () => {
                const job = createJob('new');
                const result = await isDuplicateJob(job);
                if (result.isDuplicate) {
                    throw new Error('expected new job to be considered unique');
                }
            });
        },
    },
    {
        name: 'returns duplicate after markJobAsStored',
        run: async () => {
            await withFreshStore(async () => {
                const job = createJob('stored');
                await markJobAsStored(job);
                const result = await isDuplicateJob(job);
                if (!result.isDuplicate) {
                    throw new Error('expected job to be marked as duplicate after storing');
                }
            });
        },
    },
    {
        name: 'uses url+title hash for dedup key, not object reference',
        run: async () => {
            await withFreshStore(async () => {
                const jobA = createJob('hash');
                const jobB = { ...jobA, company: 'Example Corp' };
                await markJobAsStored(jobA);
                const result = await isDuplicateJob(jobB);
                if (!result.isDuplicate) {
                    throw new Error('expected duplicate detection across object copies');
                }
            });
        },
    },
    {
        name: 'different url = not a duplicate',
        run: async () => {
            await withFreshStore(async () => {
                const jobA = createJob('unique');
                const jobB = createJob('unique-alt', { title: jobA.title });
                await markJobAsStored(jobA);
                const result = await isDuplicateJob(jobB);
                if (result.isDuplicate) {
                    throw new Error('expected different URL to be treated as unique');
                }
            });
        },
    },
];

export default tests;
