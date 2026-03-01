export interface BatchRunResult {
    stored: number;
    skipped: number;
    durationMs: number;
}

export async function runJobsParallel<T>(
    jobs: T[],
    worker: (job: T) => Promise<boolean>
): Promise<BatchRunResult> {
    const startedAt = Date.now();
    const outcomes = await Promise.all(jobs.map((job) => worker(job)));
    const stored = outcomes.filter(Boolean).length;
    return {
        stored,
        skipped: outcomes.length - stored,
        durationMs: Date.now() - startedAt,
    };
}

export async function runJobsSerial<T>(
    jobs: T[],
    worker: (job: T) => Promise<boolean>
): Promise<BatchRunResult> {
    const startedAt = Date.now();
    let stored = 0;
    let skipped = 0;

    for (const job of jobs) {
        const ok = await worker(job);
        if (ok) stored++;
        else skipped++;
    }

    return {
        stored,
        skipped,
        durationMs: Date.now() - startedAt,
    };
}
