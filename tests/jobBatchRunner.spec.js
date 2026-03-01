import { runJobsParallel, runJobsSerial } from '../dist/utils/jobBatchRunner.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const testCases = [
    {
        name: 'runJobsParallel persists all jobs and outperforms serial execution',
        run: async () => {
            const jobs = Array.from({ length: 50 }, (_, i) => i + 1);
            const delayMs = 10;

            const serial = await runJobsSerial(jobs, async () => {
                await sleep(delayMs);
                return true;
            });

            const parallel = await runJobsParallel(jobs, async () => {
                await sleep(delayMs);
                return true;
            });

            if (serial.stored !== 50 || parallel.stored !== 50) {
                throw new Error(`expected all 50 jobs to persist, got serial=${serial.stored} parallel=${parallel.stored}`);
            }

            if (parallel.durationMs >= serial.durationMs) {
                throw new Error(`expected parallel duration < serial duration, got parallel=${parallel.durationMs} serial=${serial.durationMs}`);
            }
        },
    },
];

export default testCases;
