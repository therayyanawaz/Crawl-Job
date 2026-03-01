const REQUEST_START_KEY = '__startedAt';

export function markRequestStart(request: any, now: number = Date.now()): void {
    request[REQUEST_START_KEY] = now;
}

export function getRequestLatencyMs(
    request: any,
    now: number = Date.now()
): number | null {
    const startedAt = Number(request?.[REQUEST_START_KEY]);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
        return null;
    }

    const elapsed = now - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
        return null;
    }

    return elapsed;
}
