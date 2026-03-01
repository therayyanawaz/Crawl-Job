import { decideHeadlessLaunch } from '../dist/utils/headlessDecision.js';

async function runHeadlessIfNeeded(preCollectedJobs, threshold, launchFn) {
    const decision = decideHeadlessLaunch(preCollectedJobs, threshold);
    if (decision.shouldLaunch) {
        await launchFn();
    }
    return decision;
}

const testCases = [
    {
        name: 'API tier with 30 jobs skips headless launch at threshold 25',
        run: async () => {
            let launchCount = 0;
            const decision = await runHeadlessIfNeeded(30, 25, async () => {
                launchCount++;
            });

            if (launchCount !== 0) {
                throw new Error(`expected headless launchCount=0, got ${launchCount}`);
            }
            if (decision.shouldLaunch !== false) {
                throw new Error('expected headless launch to be skipped');
            }
            if (!decision.reason.includes('skip-threshold-reached')) {
                throw new Error(`expected skip reason, got: ${decision.reason}`);
            }
        },
    },
    {
        name: 'API tier with 10 jobs launches headless at threshold 25',
        run: async () => {
            let launchCount = 0;
            const decision = await runHeadlessIfNeeded(10, 25, async () => {
                launchCount++;
            });

            if (launchCount !== 1) {
                throw new Error(`expected headless launchCount=1, got ${launchCount}`);
            }
            if (decision.shouldLaunch !== true) {
                throw new Error('expected headless launch to run');
            }
            if (decision.partialCollection !== true) {
                throw new Error('expected partialCollection=true for 10/25');
            }
        },
    },
];

export default testCases;
