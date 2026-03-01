import { dedupeJobsWithStats } from '../dist/sources/dedupFingerprint.js';

function makeJob(index) {
    return {
        title: `Software Engineer ${index}`,
        company: `Company ${index % 30}`,
        location: 'India',
        description: `Role ${index}`,
        url: `https://jobs.example.com/postings/${index}?utm=test`,
        source: 'naukri',
        platformJobId: `JOB-${index}`,
    };
}

const testCases = [
    {
        name: 'dedupeJobsWithStats handles 500 jobs with 40 percent duplicates using set lookups',
        run: async () => {
            const uniqueCount = 300;
            const duplicateCount = 200;

            const uniqueJobs = Array.from({ length: uniqueCount }, (_, i) => makeJob(i + 1));
            const duplicateJobs = Array.from({ length: duplicateCount }, (_, i) => {
                const original = uniqueJobs[i % uniqueJobs.length];
                return {
                    ...original,
                    title: `${original.title}   `,
                    source: 'NAUKRI', // normalized source slug should still dedupe
                    url: `${original.url}#tracking`,
                };
            });

            const mixed = [];
            for (let i = 0; i < uniqueJobs.length; i++) {
                mixed.push(uniqueJobs[i]);
                if (i < duplicateJobs.length) {
                    mixed.push(duplicateJobs[i]);
                }
            }

            const stats = dedupeJobsWithStats(mixed);

            if (stats.uniqueJobs.length !== uniqueCount) {
                throw new Error(`expected ${uniqueCount} unique jobs, got ${stats.uniqueJobs.length}`);
            }
            if (stats.duplicateCount !== duplicateCount) {
                throw new Error(`expected ${duplicateCount} duplicates, got ${stats.duplicateCount}`);
            }
            if (stats.lookupCount !== mixed.length) {
                throw new Error(`expected one set lookup per job (${mixed.length}), got ${stats.lookupCount}`);
            }

            const expectedRatio = duplicateCount / mixed.length;
            const delta = Math.abs(stats.dedupHitRatio - expectedRatio);
            if (delta > 1e-9) {
                throw new Error(`expected dedup ratio ${expectedRatio}, got ${stats.dedupHitRatio}`);
            }
        },
    },
];

export default testCases;
