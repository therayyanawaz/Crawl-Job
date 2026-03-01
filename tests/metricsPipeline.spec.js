import {
    closeMetrics,
    getMetricsSnapshot,
    initMetrics,
    recordJobDeduplicated,
    recordJobExtracted,
    recordJobPersistenceFailed,
    recordJobStored,
} from '../dist/utils/metrics.js';
import { getHealthStatus } from '../dist/utils/healthCheck.js';

const testCases = [
    {
        name: 'unique job flow increments extracted and stored counters',
        run: async () => {
            initMetrics();
            try {
                recordJobExtracted();
                recordJobStored();

                const snapshot = getMetricsSnapshot();
                if (snapshot.jobsExtracted !== 1) {
                    throw new Error(`expected jobsExtracted=1, got ${snapshot.jobsExtracted}`);
                }
                if (snapshot.jobsStored !== 1) {
                    throw new Error(`expected jobsStored=1, got ${snapshot.jobsStored}`);
                }
                if (snapshot.jobsDeduplicated !== 0) {
                    throw new Error(`expected jobsDeduplicated=0, got ${snapshot.jobsDeduplicated}`);
                }
                if (snapshot.jobsPersistenceFailed !== 0) {
                    throw new Error(`expected jobsPersistenceFailed=0, got ${snapshot.jobsPersistenceFailed}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
    {
        name: 'duplicate job flow increments dedup counter and keeps stored unchanged',
        run: async () => {
            initMetrics();
            try {
                recordJobExtracted();
                recordJobDeduplicated();

                const snapshot = getMetricsSnapshot();
                if (snapshot.jobsExtracted !== 1) {
                    throw new Error(`expected jobsExtracted=1, got ${snapshot.jobsExtracted}`);
                }
                if (snapshot.jobsDeduplicated !== 1) {
                    throw new Error(`expected jobsDeduplicated=1, got ${snapshot.jobsDeduplicated}`);
                }
                if (snapshot.jobsStored !== 0) {
                    throw new Error(`expected jobsStored=0, got ${snapshot.jobsStored}`);
                }
                if (snapshot.dedupRatioPct !== 100) {
                    throw new Error(`expected dedupRatioPct=100, got ${snapshot.dedupRatioPct}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
    {
        name: 'persistence failure flow increments failure counter without incrementing stored',
        run: async () => {
            initMetrics();
            try {
                recordJobExtracted();
                recordJobPersistenceFailed();

                const snapshot = getMetricsSnapshot();
                if (snapshot.jobsExtracted !== 1) {
                    throw new Error(`expected jobsExtracted=1, got ${snapshot.jobsExtracted}`);
                }
                if (snapshot.jobsStored !== 0) {
                    throw new Error(`expected jobsStored=0, got ${snapshot.jobsStored}`);
                }
                if (snapshot.jobsPersistenceFailed !== 1) {
                    throw new Error(`expected jobsPersistenceFailed=1, got ${snapshot.jobsPersistenceFailed}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
    {
        name: 'health summary includes productivity signals (jobs/min and dedup ratio)',
        run: async () => {
            initMetrics();
            try {
                recordJobExtracted();
                recordJobExtracted();
                recordJobDeduplicated();
                recordJobStored();

                const report = getHealthStatus();
                if (!report.summary.includes('jobs/min')) {
                    throw new Error(`expected jobs/min in summary, got: ${report.summary}`);
                }
                if (!report.summary.includes('dedup')) {
                    throw new Error(`expected dedup signal in summary, got: ${report.summary}`);
                }
            } finally {
                closeMetrics();
            }
        },
    },
];

export default testCases;
