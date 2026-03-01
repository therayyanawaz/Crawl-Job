import * as crypto from 'crypto';

export interface RunContext {
    runId: string;
    startedAt: string;
    platform: string;
}

export function createRunContext(): RunContext {
    return {
        runId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        platform: process.platform,
    };
}
