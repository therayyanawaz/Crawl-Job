import { log } from 'crawlee';

const rawPersistConcurrency = Number.parseInt(
    process.env.PERSIST_CONCURRENCY ?? '',
    10
);
const PERSIST_CONCURRENCY = Number.isInteger(rawPersistConcurrency) && rawPersistConcurrency > 0
    ? rawPersistConcurrency
    : 15;

type PersistenceTask = () => Promise<void>;

const queuedTasks: PersistenceTask[] = [];
let activeTasks = 0;
let drainResolvers: Array<() => void> = [];

function resolveDrainersIfIdle(): void {
    if (activeTasks !== 0 || queuedTasks.length !== 0) {
        return;
    }

    const waiters = drainResolvers;
    drainResolvers = [];
    for (const resolve of waiters) {
        resolve();
    }
}

function pumpQueue(): void {
    while (activeTasks < PERSIST_CONCURRENCY && queuedTasks.length > 0) {
        const task = queuedTasks.shift();
        if (!task) break;

        activeTasks++;

        Promise.resolve()
            .then(task)
            .catch((err: any) => {
                log.error(`[PersistenceQueue] Task failed: ${err?.message ?? String(err)}`);
            })
            .finally(() => {
                activeTasks = Math.max(0, activeTasks - 1);
                pumpQueue();
                resolveDrainersIfIdle();
            });
    }
}

export function enqueuePersistenceTask(task: PersistenceTask): void {
    queuedTasks.push(task);
    pumpQueue();
}

export async function drainPersistenceQueue(): Promise<void> {
    if (activeTasks === 0 && queuedTasks.length === 0) {
        return;
    }

    await new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
    });
}

export function getPersistConcurrency(): number {
    return PERSIST_CONCURRENCY;
}

export function getPersistenceQueueStats(): { active: number; queued: number } {
    return {
        active: activeTasks,
        queued: queuedTasks.length,
    };
}

export function __resetPersistenceQueueForTests(): void {
    queuedTasks.length = 0;
    activeTasks = 0;
    drainResolvers = [];
}
