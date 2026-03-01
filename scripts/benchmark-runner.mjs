#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
    const args = { profile: 'small', output: '' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--profile' && argv[i + 1]) {
            args.profile = argv[i + 1];
            i++;
            continue;
        }
        if (argv[i] === '--output' && argv[i + 1]) {
            args.output = argv[i + 1];
            i++;
        }
    }
    return args;
}

function readProfile(profileName) {
    const profilePath = path.join(process.cwd(), 'testdata', 'benchmark', `${profileName}.json`);
    if (!fs.existsSync(profilePath)) {
        throw new Error(`Unknown benchmark profile "${profileName}" (${profilePath})`);
    }
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function deterministicLatency(index, base, jitter) {
    const spread = Math.max(1, Number(jitter) || 1);
    return base + ((index * 31 + 7) % spread);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const profile = readProfile(args.profile);

    const metricsModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'utils', 'metrics.js')).href;
    const metrics = await import(metricsModuleUrl);
    const {
        initMetrics,
        closeMetrics,
        getMetricsSnapshot,
        recordRequestStarted,
        recordRequestSuccess,
        recordRequestFailed,
        recordJobExtracted,
        recordJobDeduplicated,
        recordJobStored,
        recordJobPersistenceFailed,
        recordRateLimitHit,
        recordProxyFailure,
    } = metrics;

    initMetrics();
    try {
        const requestsStarted = Number(profile.requestsStarted ?? 0);
        const failureModulo = Math.max(1, Number(profile.failureModulo ?? 10));
        const latencyBaseMs = Number(profile.latencyBaseMs ?? 100);
        const latencyJitterMs = Number(profile.latencyJitterMs ?? 50);

        for (let i = 0; i < requestsStarted; i++) {
            recordRequestStarted();
            const failed = i % failureModulo === 0;
            if (failed) {
                recordRequestFailed();
                continue;
            }
            recordRequestSuccess(deterministicLatency(i, latencyBaseMs, latencyJitterMs));
        }

        const jobsExtracted = Number(profile.jobsExtracted ?? 0);
        const jobsDeduplicated = Number(profile.jobsDeduplicated ?? 0);
        const jobsStored = Number(profile.jobsStored ?? 0);
        const jobsPersistenceFailed = Number(profile.jobsPersistenceFailed ?? 0);
        const rateLimitHits = Number(profile.rateLimitHits ?? 0);
        const proxyFailures = Number(profile.proxyFailures ?? 0);

        for (let i = 0; i < jobsExtracted; i++) recordJobExtracted();
        for (let i = 0; i < jobsDeduplicated; i++) recordJobDeduplicated();
        for (let i = 0; i < jobsStored; i++) recordJobStored();
        for (let i = 0; i < jobsPersistenceFailed; i++) recordJobPersistenceFailed();
        for (let i = 0; i < rateLimitHits; i++) recordRateLimitHit();
        for (let i = 0; i < proxyFailures; i++) recordProxyFailure();

        const snapshot = getMetricsSnapshot();
        const simulatedDurationSeconds = Math.max(1, Number(profile.simulatedDurationSeconds ?? 60));
        const jobsPerMinute = round1((jobsExtracted * 60) / simulatedDurationSeconds);
        const dedupRatioPct = snapshot.dedupRatioPct;
        const p95LatencyMs = snapshot.p95ResponseTimeMs;
        const proxyPassRatePct = requestsStarted > 0
            ? round1(((requestsStarted - proxyFailures) / requestsStarted) * 100)
            : 100;
        const rateLimitRatePct = requestsStarted > 0
            ? round1((rateLimitHits / requestsStarted) * 100)
            : 0;

        const result = {
            profile: profile.profile ?? args.profile,
            generatedAt: new Date().toISOString(),
            simulatedDurationSeconds,
            kpi: {
                jobsPerMinute,
                dedupRatioPct,
                p95LatencyMs,
                proxyPassRatePct,
                rateLimitRatePct,
            },
            snapshot,
            input: profile,
        };

        const outputPath = args.output
            ? (path.isAbsolute(args.output) ? args.output : path.join(process.cwd(), args.output))
            : path.join(process.cwd(), 'storage', 'benchmarks', `kpi-${result.profile}.json`);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

        console.log('');
        console.log(`Benchmark Profile: ${result.profile}`);
        console.log('KPI                    Value');
        console.log('---------------------  --------');
        console.log(`jobs/min               ${jobsPerMinute}`);
        console.log(`dedup ratio (%)        ${dedupRatioPct}`);
        console.log(`p95 latency (ms)       ${p95LatencyMs}`);
        console.log(`proxy pass rate (%)    ${proxyPassRatePct}`);
        console.log(`429 rate (%)           ${rateLimitRatePct}`);
        console.log(`artifact               ${outputPath}`);
    } finally {
        closeMetrics();
    }
}

main().catch((err) => {
    console.error(`[benchmark] ${err?.message ?? String(err)}`);
    process.exit(1);
});
