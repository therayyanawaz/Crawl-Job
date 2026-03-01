import {
    initMetrics,
    closeMetrics,
    getMetricsSnapshot,
    recordRequestSuccess,
} from '../dist/utils/metrics.js';
import { markRequestStart, getRequestLatencyMs } from '../dist/utils/requestTiming.js';

const testCases = [
    {
        name: 'request latency is positive and propagates into metrics summary',
        run: async () => {
            initMetrics();
            try {
                const request = {};
                markRequestStart(request, 1_000);
                const latencyMs = getRequestLatencyMs(request, 1_035);

                if (latencyMs === null || latencyMs <= 0) {
                    throw new Error(`expected positive latency, got ${latencyMs}`);
                }

                recordRequestSuccess(latencyMs);
                const snapshot = getMetricsSnapshot();
                if (snapshot.avgResponseTimeMs <= 0) {
                    throw new Error(`expected avgResponseTimeMs > 0, got ${snapshot.avgResponseTimeMs}`);
                }
                if (snapshot.p95ResponseTimeMs <= 0) {
                    throw new Error(`expected p95ResponseTimeMs > 0, got ${snapshot.p95ResponseTimeMs}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
    {
        name: 'missing request start does not produce invalid latency sample',
        run: async () => {
            initMetrics();
            try {
                const request = {};
                const latencyMs = getRequestLatencyMs(request, 2_000);
                if (latencyMs !== null) {
                    throw new Error(`expected null latency for missing start, got ${latencyMs}`);
                }

                recordRequestSuccess(latencyMs ?? undefined);
                const snapshot = getMetricsSnapshot();
                if (!Number.isFinite(snapshot.avgResponseTimeMs)) {
                    throw new Error(`expected finite avgResponseTimeMs, got ${snapshot.avgResponseTimeMs}`);
                }
                if (!Number.isFinite(snapshot.p95ResponseTimeMs)) {
                    throw new Error(`expected finite p95ResponseTimeMs, got ${snapshot.p95ResponseTimeMs}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
];

export default testCases;
