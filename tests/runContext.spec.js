import { createRunContext } from '../dist/utils/runContext.js';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const tests = [
    {
        name: 'returns an object with runId, startedAt, platform',
        run: async () => {
            const ctx = createRunContext();
            if (!ctx.runId || !ctx.startedAt || !ctx.platform) {
                throw new Error('run context missing required properties');
            }
        },
    },
    {
        name: 'runId is a valid UUID v4',
        run: async () => {
            const ctx = createRunContext();
            if (!uuidV4.test(ctx.runId)) {
                throw new Error(`runId is not a UUID v4: ${ctx.runId}`);
            }
        },
    },
    {
        name: 'startedAt is a valid ISO 8601 timestamp',
        run: async () => {
            const ctx = createRunContext();
            const iso = new Date(ctx.startedAt).toISOString();
            if (iso !== ctx.startedAt) {
                throw new Error(`startedAt is not ISO-8601: ${ctx.startedAt}`);
            }
        },
    },
    {
        name: 'each call returns a unique runId',
        run: async () => {
            const first = createRunContext();
            const second = createRunContext();
            if (first.runId === second.runId) {
                throw new Error('expected distinct runIds per call');
            }
        },
    },
    {
        name: 'platform matches process.platform',
        run: async () => {
            const ctx = createRunContext();
            if (ctx.platform !== process.platform) {
                throw new Error(`platform mismatch: ${ctx.platform} vs ${process.platform}`);
            }
        },
    },
];

export default tests;
