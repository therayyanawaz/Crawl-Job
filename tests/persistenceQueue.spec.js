import {
    enqueuePersistenceTask,
    drainPersistenceQueue,
    getPersistConcurrency,
    getPersistenceQueueStats,
    __resetPersistenceQueueForTests,
} from '../dist/utils/persistenceQueue.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const testCases = [
    {
        name: 'persistence queue enforces bounded concurrency',
        run: async () => {
            __resetPersistenceQueueForTests();

            const limit = getPersistConcurrency();
            const totalTasks = 40;
            let active = 0;
            let maxActive = 0;
            let completed = 0;

            for (let i = 0; i < totalTasks; i++) {
                enqueuePersistenceTask(async () => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await sleep(15);
                    active--;
                    completed++;
                });
            }

            await drainPersistenceQueue();

            if (completed !== totalTasks) {
                throw new Error(`expected ${totalTasks} completed tasks, got ${completed}`);
            }
            if (maxActive > limit) {
                throw new Error(`expected maxActive <= ${limit}, got ${maxActive}`);
            }
        },
    },
    {
        name: 'drainPersistenceQueue waits until queued work fully completes',
        run: async () => {
            __resetPersistenceQueueForTests();

            let completed = false;
            enqueuePersistenceTask(async () => {
                await sleep(20);
                completed = true;
            });

            await drainPersistenceQueue();

            if (!completed) {
                throw new Error('expected drainPersistenceQueue to wait for task completion');
            }

            const stats = getPersistenceQueueStats();
            if (stats.active !== 0 || stats.queued !== 0) {
                throw new Error(`expected empty queue after drain, got active=${stats.active} queued=${stats.queued}`);
            }
        },
    },
];

export default testCases;
