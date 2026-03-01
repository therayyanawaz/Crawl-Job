export interface HeadlessLaunchDecision {
    shouldLaunch: boolean;
    partialCollection: boolean;
    reason: string;
    preCollectedJobs: number;
    threshold: number;
}

function sanitizeNonNegativeInt(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return Math.max(0, parsed);
        }
    }
    return Math.max(1, Math.floor(fallback));
}

export function resolveHeadlessSkipThreshold(value: unknown, fallback = 25): number {
    const threshold = sanitizeNonNegativeInt(value, fallback);
    return threshold > 0 ? threshold : fallback;
}

export function decideHeadlessLaunch(preCollectedJobs: number, skipThreshold: number): HeadlessLaunchDecision {
    const collected = sanitizeNonNegativeInt(preCollectedJobs, 0);
    const threshold = resolveHeadlessSkipThreshold(skipThreshold, 25);
    const partialCollection = collected > 0 && collected < threshold;
    const shouldLaunch = collected < threshold;

    if (!shouldLaunch) {
        return {
            shouldLaunch,
            partialCollection: false,
            reason: `skip-threshold-reached (${collected} >= ${threshold})`,
            preCollectedJobs: collected,
            threshold,
        };
    }

    return {
        shouldLaunch,
        partialCollection,
        reason: partialCollection
            ? `partial-api-collection (${collected}/${threshold})`
            : `no-api-jobs-collected (threshold=${threshold})`,
        preCollectedJobs: collected,
        threshold,
    };
}
